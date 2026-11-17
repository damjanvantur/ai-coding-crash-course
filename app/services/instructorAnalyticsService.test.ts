import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the services pick up our test db
import { getInstructorAnalytics } from "./instructorAnalyticsService";
import { enrollUser } from "./enrollmentService";
import { createPurchase, createTeamPurchase } from "./purchaseService";
import { redeemCoupon } from "./couponService";
import { createComment } from "./commentService";
import { createQuiz, recordAttempt } from "./quizService";

function createUser(
  name: string,
  email: string,
  role: schema.UserRole = schema.UserRole.Student
) {
  return testDb
    .insert(schema.users)
    .values({ name, email, role })
    .returning()
    .get();
}

function createCourse(
  slug: string,
  instructorId: number,
  status: schema.CourseStatus = schema.CourseStatus.Published
) {
  return testDb
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: "A course",
      salesCopy: "Sales copy.",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function createLesson(courseId: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "Lesson", position: 1 })
    .returning()
    .get();
}

function createCourseQuiz(courseId: number, passingScore = 0.7) {
  return createQuiz(createLesson(courseId).id, "Quiz", passingScore);
}

function courseStats(
  analytics: ReturnType<typeof getInstructorAnalytics>,
  courseId: number
) {
  return analytics.courses.find((c) => c.courseId === courseId);
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

describe("getInstructorAnalytics", () => {
  it("counts a student in two courses once in the summary and once per course", () => {
    const second = createCourse("second", base.instructor.id);
    const other = createUser("Other", "other@example.com");
    enrollUser(base.user.id, base.course.id, false, false);
    enrollUser(base.user.id, second.id, false, false);
    enrollUser(other.id, second.id, false, false);

    const analytics = getInstructorAnalytics(base.instructor.id);

    expect(analytics.summary.uniqueStudents).toBe(2);
    expect(courseStats(analytics, base.course.id)?.enrollments).toBe(1);
    expect(courseStats(analytics, second.id)?.enrollments).toBe(2);
  });

  it("counts students who joined via a team seat as enrolled", () => {
    const buyer = createUser("Buyer", "buyer@example.com");
    const seatHolder = createUser("Seat", "seat@example.com");
    const { coupons } = createTeamPurchase(
      buyer.id,
      base.course.id,
      30000,
      "US",
      3
    );
    expect(redeemCoupon(coupons[0].code, seatHolder.id, "US").ok).toBe(true);

    const analytics = getInstructorAnalytics(base.instructor.id);

    expect(analytics.summary.uniqueStudents).toBe(1);
    expect(courseStats(analytics, base.course.id)?.enrollments).toBe(1);
  });

  it("sums the amount actually paid, including PPP-discounted and team purchases", () => {
    const pppBuyer = createUser("PPP", "ppp@example.com");
    const teamBuyer = createUser("Team", "team@example.com");
    createPurchase(base.user.id, base.course.id, 4999, "US");
    createPurchase(pppBuyer.id, base.course.id, 1999, "IN");
    createTeamPurchase(teamBuyer.id, base.course.id, 25000, "US", 5);

    const analytics = getInstructorAnalytics(base.instructor.id);

    expect(analytics.summary.revenueCents).toBe(31998);
    expect(courseStats(analytics, base.course.id)?.revenueCents).toBe(31998);
  });

  it("reports 0 revenue for a free course", () => {
    const free = createCourse("free", base.instructor.id);
    enrollUser(base.user.id, free.id, false, false);
    createPurchase(base.user.id, base.course.id, 4999, "US");

    const analytics = getInstructorAnalytics(base.instructor.id);

    expect(courseStats(analytics, free.id)?.revenueCents).toBe(0);
    expect(analytics.summary.revenueCents).toBe(4999);
  });

  it("includes draft and archived courses in the courses and the totals", () => {
    const draft = createCourse("draft", base.instructor.id, schema.CourseStatus.Draft);
    const archived = createCourse(
      "archived",
      base.instructor.id,
      schema.CourseStatus.Archived
    );
    const other = createUser("Other", "other@example.com");
    enrollUser(base.user.id, draft.id, false, false);
    createPurchase(base.user.id, draft.id, 1000, "US");
    enrollUser(other.id, archived.id, false, false);
    createPurchase(other.id, archived.id, 2000, "US");

    const analytics = getInstructorAnalytics(base.instructor.id);

    expect(analytics.courses.map((c) => c.courseId).sort()).toEqual(
      [base.course.id, draft.id, archived.id].sort()
    );
    expect(analytics.summary.uniqueStudents).toBe(2);
    expect(analytics.summary.revenueCents).toBe(3000);
    expect(courseStats(analytics, archived.id)).toMatchObject({
      courseId: archived.id,
      enrollments: 1,
      revenueCents: 2000,
    });
  });

  it("excludes another instructor's courses, students, purchases and questions", () => {
    const otherInstructor = createUser(
      "Other Instructor",
      "other-instructor@example.com",
      schema.UserRole.Instructor
    );
    const theirs = createCourse("theirs", otherInstructor.id);
    const theirStudent = createUser("Theirs", "theirs@example.com");
    enrollUser(theirStudent.id, theirs.id, false, false);
    createPurchase(theirStudent.id, theirs.id, 9999, "US");
    createComment(theirStudent.id, createLesson(theirs.id).id, null, "Help?");
    enrollUser(base.user.id, base.course.id, false, false);
    createPurchase(base.user.id, base.course.id, 4999, "US");

    const analytics = getInstructorAnalytics(base.instructor.id);

    expect(analytics.courses.map((c) => c.courseId)).toEqual([base.course.id]);
    expect(analytics.summary).toMatchObject({
      uniqueStudents: 1,
      revenueCents: 4999,
      unansweredQuestions: 0,
    });
  });

  it("counts questions still waiting on an answer from the instructor", () => {
    const lesson = createLesson(base.course.id);
    const other = createUser("Other", "other@example.com");
    createComment(base.user.id, lesson.id, null, "Waiting 1");
    createComment(other.id, lesson.id, null, "Waiting 2");
    const answered = createComment(base.user.id, lesson.id, null, "Answered");
    createComment(base.instructor.id, lesson.id, answered.id, "Here you go");

    const analytics = getInstructorAnalytics(base.instructor.id);

    expect(analytics.summary.unansweredQuestions).toBe(2);
  });

  describe("quiz score", () => {
    it("counts each student's best attempt rather than their latest", () => {
      const quiz = createCourseQuiz(base.course.id);
      recordAttempt(base.user.id, quiz.id, 0.9, true);
      recordAttempt(base.user.id, quiz.id, 0.5, false);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseStats(analytics, base.course.id)?.avgQuizScore).toBe(90);
      expect(analytics.summary.avgQuizScore).toBe(90);
    });

    it("counts a best score exactly equal to the passing score as a pass, ignoring the stored passed flag", () => {
      const quiz = createCourseQuiz(base.course.id, 0.7);
      const other = createUser("Other", "other@example.com");
      recordAttempt(base.user.id, quiz.id, 0.7, false);
      recordAttempt(other.id, quiz.id, 0.6, true);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.summary.quizPassRate).toBe(50);
    });

    it("judges each quiz by its own passing score", () => {
      const lenient = createCourseQuiz(base.course.id, 0.5);
      const strict = createCourseQuiz(base.course.id, 0.9);
      recordAttempt(base.user.id, lenient.id, 0.6, false);
      recordAttempt(base.user.id, strict.id, 0.8, true);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.summary.quizPassRate).toBe(50);
      expect(analytics.summary.avgQuizScore).toBe(70);
    });

    it("is null when there are no attempts, and for a course with no quizzes", () => {
      createCourseQuiz(base.course.id);
      const noQuizzes = createCourse("no-quizzes", base.instructor.id);
      enrollUser(base.user.id, noQuizzes.id, false, false);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.summary.avgQuizScore).toBeNull();
      expect(analytics.summary.quizPassRate).toBeNull();
      expect(courseStats(analytics, base.course.id)?.avgQuizScore).toBeNull();
      expect(courseStats(analytics, noQuizzes.id)?.avgQuizScore).toBeNull();
    });

    it("pools the summary across every (student, quiz) pair of all courses", () => {
      const second = createCourse("second", base.instructor.id);
      const firstQuiz = createCourseQuiz(base.course.id, 0.7);
      const secondQuiz = createCourseQuiz(second.id, 0.7);
      const other = createUser("Other", "other@example.com");
      const third = createUser("Third", "third@example.com");
      recordAttempt(base.user.id, firstQuiz.id, 1, true);
      recordAttempt(base.user.id, secondQuiz.id, 0.4, false);
      recordAttempt(other.id, secondQuiz.id, 0.5, false);
      recordAttempt(third.id, secondQuiz.id, 0.9, true);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseStats(analytics, base.course.id)?.avgQuizScore).toBe(100);
      expect(courseStats(analytics, second.id)?.avgQuizScore).toBe(60);
      // Pooled pairs (100 + 40 + 50 + 90) / 4, not the mean of course averages.
      expect(analytics.summary.avgQuizScore).toBe(70);
      expect(analytics.summary.quizPassRate).toBe(50);
    });

    it("excludes another instructor's quiz attempts", () => {
      const otherInstructor = createUser(
        "Other Instructor",
        "other-instructor@example.com",
        schema.UserRole.Instructor
      );
      const theirs = createCourse("theirs", otherInstructor.id);
      const theirQuiz = createCourseQuiz(theirs.id);
      const ownQuiz = createCourseQuiz(base.course.id);
      recordAttempt(base.user.id, theirQuiz.id, 0.2, false);
      recordAttempt(base.user.id, ownQuiz.id, 0.8, true);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.summary.avgQuizScore).toBe(80);
      expect(analytics.summary.quizPassRate).toBe(100);
    });
  });
});
