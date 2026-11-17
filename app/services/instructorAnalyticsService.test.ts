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
import { markLessonComplete, markLessonInProgress } from "./progressService";

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

function createLessons(courseId: number, count: number) {
  return Array.from({ length: count }, () => createLesson(courseId));
}

function enrollWithProgress(
  userId: number,
  courseId: number,
  completedLessons: Array<{ id: number }>
) {
  enrollUser(userId, courseId, false, false);
  for (const lesson of completedLessons) markLessonComplete(userId, lesson.id);
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

  describe("completion and progress", () => {
    it("counts an enrollment complete only when every lesson is completed", () => {
      const lessons = createLessons(base.course.id, 2);
      const other = createUser("Other", "other@example.com");
      enrollWithProgress(base.user.id, base.course.id, lessons);
      enrollWithProgress(other.id, base.course.id, [lessons[0]]);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseStats(analytics, base.course.id)?.completionRate).toBe(50);
      expect(analytics.summary.completionRate).toBe(50);
    });

    it("never counts an enrollment in a zero-lesson course as complete", () => {
      enrollWithProgress(base.user.id, base.course.id, []);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseStats(analytics, base.course.id)?.completionRate).toBe(0);
      expect(analytics.summary.completionRate).toBe(0);
    });

    it("reports null completion and progress when there are no enrollments", () => {
      createLessons(base.course.id, 2);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseStats(analytics, base.course.id)?.completionRate).toBeNull();
      expect(analytics.summary.completionRate).toBeNull();
      expect(analytics.summary.avgProgress).toBeNull();
    });

    it("averages each enrollment's share of completed lessons", () => {
      const lessons = createLessons(base.course.id, 4);
      const other = createUser("Other", "other@example.com");
      const third = createUser("Third", "third@example.com");
      enrollWithProgress(base.user.id, base.course.id, lessons); // 100%
      enrollWithProgress(other.id, base.course.id, lessons.slice(0, 1)); // 25%
      enrollWithProgress(third.id, base.course.id, []); // 0%

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.summary.avgProgress).toBe(42); // 125 / 3 = 41.67
    });

    it("pools the summary across enrollments, not per-course averages", () => {
      const big = createCourse("big", base.instructor.id);
      const bigLessons = createLessons(big.id, 2);
      const smallLessons = createLessons(base.course.id, 2);
      const students = ["a", "b", "c"].map((n) =>
        createUser(n, `${n}@example.com`)
      );
      // Small course: 1 student, finished. Big course: 3 students, one half done.
      enrollWithProgress(base.user.id, base.course.id, smallLessons);
      enrollWithProgress(students[0].id, big.id, bigLessons.slice(0, 1));
      enrollWithProgress(students[1].id, big.id, []);
      enrollWithProgress(students[2].id, big.id, []);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseStats(analytics, base.course.id)?.completionRate).toBe(100);
      expect(courseStats(analytics, big.id)?.completionRate).toBe(0);
      expect(analytics.summary.completionRate).toBe(25); // not (100 + 0) / 2
      expect(analytics.summary.avgProgress).toBe(38); // (100 + 50) / 4 = 37.5
    });

    it("excludes another instructor's students' progress", () => {
      const otherInstructor = createUser(
        "Other Instructor",
        "other-instructor@example.com",
        schema.UserRole.Instructor
      );
      const theirs = createCourse("theirs", otherInstructor.id);
      const theirLessons = createLessons(theirs.id, 1);
      const ourLessons = createLessons(base.course.id, 2);
      enrollWithProgress(base.user.id, theirs.id, theirLessons);
      enrollWithProgress(base.user.id, base.course.id, []);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.summary.completionRate).toBe(0);
      expect(analytics.summary.avgProgress).toBe(0);
    });

    it("counts lessons only, ignoring quizzes and in-progress lessons", () => {
      const lessons = createLessons(base.course.id, 2);
      testDb
        .insert(schema.quizzes)
        .values({ lessonId: lessons[0].id, title: "Quiz", passingScore: 0.7 })
        .run();
      enrollWithProgress(base.user.id, base.course.id, lessons);
      const other = createUser("Other", "other@example.com");
      enrollWithProgress(other.id, base.course.id, []);
      markLessonInProgress(other.id, lessons[0].id);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.summary.completionRate).toBe(50);
      expect(analytics.summary.avgProgress).toBe(50);
    });
  });
});
