import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { CourseStatus, LessonProgressStatus, UserRole } from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import { getInstructorAnalytics } from "./instructorAnalyticsService";

let nextId = 1;

function createUser(role: UserRole = UserRole.Student) {
  const n = nextId++;
  return testDb
    .insert(schema.users)
    .values({ name: `User ${n}`, email: `user${n}@example.com`, role })
    .returning()
    .get();
}

function createCourse(
  instructorId: number,
  status: CourseStatus = CourseStatus.Published
) {
  const n = nextId++;
  return testDb
    .insert(schema.courses)
    .values({
      title: `Course ${n}`,
      slug: `course-${n}`,
      description: "A course",
      salesCopy: "Sales copy",
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

function enroll(userId: number, courseId: number) {
  testDb.insert(schema.enrollments).values({ userId, courseId }).run();
}

function purchase(userId: number, courseId: number, amountPaid: number) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, country: "US" })
    .returning()
    .get();
}

// A student buys the course and is enrolled in it.
function buyAndEnroll(userId: number, courseId: number, amountPaid: number) {
  purchase(userId, courseId, amountPaid);
  enroll(userId, courseId);
}

// A team admin buys seats; `seatUserId` redeems one and is enrolled without a
// purchase of their own.
function teamSeat(courseId: number, amountPaid: number, seatUserId: number) {
  const admin = createUser();
  const team = testDb.insert(schema.teams).values({}).returning().get();
  const bought = purchase(admin.id, courseId, amountPaid);
  testDb
    .insert(schema.coupons)
    .values({
      teamId: team.id,
      courseId,
      code: `SEAT-${nextId++}`,
      purchaseId: bought.id,
      redeemedByUserId: seatUserId,
      redeemedAt: new Date().toISOString(),
    })
    .run();
  enroll(seatUserId, courseId);
}

function ask(userId: number, lessonId: number, parentId: number | null = null) {
  return testDb
    .insert(schema.comments)
    .values({ userId, lessonId, parentId, body: "How does this work?" })
    .returning()
    .get();
}

function recordLessonProgress(
  userId: number,
  lessonId: number,
  status: LessonProgressStatus = LessonProgressStatus.Completed
) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status,
      completedAt:
        status === LessonProgressStatus.Completed
          ? new Date().toISOString()
          : null,
    })
    .run();
}

function courseStats(instructorId: number, courseId: number) {
  return getInstructorAnalytics(instructorId).courses.find(
    (c) => c.courseId === courseId
  );
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

describe("getInstructorAnalytics", () => {
  it("returns zeros for an instructor with no courses", () => {
    const loner = createUser(UserRole.Instructor);

    expect(getInstructorAnalytics(loner.id)).toEqual({
      summary: {
        uniqueStudents: 0,
        revenueCents: 0,
        unansweredQuestions: 0,
        completionRate: null,
        avgProgress: null,
      },
      courses: [],
    });
  });

  it("counts a student in two courses once in the summary and once per course", () => {
    const second = createCourse(base.instructor.id);
    const other = createUser();
    enroll(base.user.id, base.course.id);
    enroll(base.user.id, second.id);
    enroll(other.id, second.id);

    const analytics = getInstructorAnalytics(base.instructor.id);

    expect(analytics.summary.uniqueStudents).toBe(2);
    expect(courseStats(base.instructor.id, base.course.id)?.enrollments).toBe(1);
    expect(courseStats(base.instructor.id, second.id)?.enrollments).toBe(2);
  });

  it("counts team-seat students as enrolled", () => {
    teamSeat(base.course.id, 30000, base.user.id);

    const analytics = getInstructorAnalytics(base.instructor.id);

    expect(analytics.summary.uniqueStudents).toBe(1);
    expect(courseStats(base.instructor.id, base.course.id)?.enrollments).toBe(1);
  });

  it("sums the amount paid, including PPP-discounted and team purchases", () => {
    const ppp = createUser();
    const seat = createUser();
    buyAndEnroll(base.user.id, base.course.id, 4999);
    buyAndEnroll(ppp.id, base.course.id, 1999);
    teamSeat(base.course.id, 30000, seat.id);

    const analytics = getInstructorAnalytics(base.instructor.id);

    expect(analytics.summary.revenueCents).toBe(4999 + 1999 + 30000);
    expect(courseStats(base.instructor.id, base.course.id)?.revenueCents).toBe(
      4999 + 1999 + 30000
    );
  });

  it("gives a free course 0 revenue", () => {
    const free = createCourse(base.instructor.id);
    enroll(base.user.id, free.id);

    expect(courseStats(base.instructor.id, free.id)).toEqual({
      courseId: free.id,
      enrollments: 1,
      revenueCents: 0,
      completionRate: 0,
    });
  });

  it("includes draft and archived courses", () => {
    const draft = createCourse(base.instructor.id, CourseStatus.Draft);
    const archived = createCourse(base.instructor.id, CourseStatus.Archived);
    const other = createUser();
    buyAndEnroll(base.user.id, draft.id, 1000);
    buyAndEnroll(other.id, archived.id, 2000);

    const analytics = getInstructorAnalytics(base.instructor.id);

    expect(analytics.courses.map((c) => c.courseId)).toEqual(
      expect.arrayContaining([base.course.id, draft.id, archived.id])
    );
    expect(analytics.summary.uniqueStudents).toBe(2);
    expect(analytics.summary.revenueCents).toBe(3000);
  });

  it("excludes another instructor's courses, students, purchases and questions", () => {
    const rival = createUser(UserRole.Instructor);
    const rivalCourse = createCourse(rival.id);
    const rivalStudent = createUser();
    buyAndEnroll(rivalStudent.id, rivalCourse.id, 9999);
    ask(rivalStudent.id, createLesson(rivalCourse.id).id);
    buyAndEnroll(base.user.id, base.course.id, 4999);

    const analytics = getInstructorAnalytics(base.instructor.id);

    expect(analytics.courses.map((c) => c.courseId)).toEqual([base.course.id]);
    expect(analytics.summary).toEqual({
      uniqueStudents: 1,
      revenueCents: 4999,
      unansweredQuestions: 0,
      completionRate: 0,
      avgProgress: 0,
    });
  });

  it("counts questions that have no reply from the instructor", () => {
    const lesson = createLesson(base.course.id);
    const classmate = createUser();
    ask(base.user.id, lesson.id);
    const answered = ask(base.user.id, lesson.id);
    ask(base.instructor.id, lesson.id, answered.id);
    const classmateOnly = ask(base.user.id, lesson.id);
    ask(classmate.id, lesson.id, classmateOnly.id);

    expect(
      getInstructorAnalytics(base.instructor.id).summary.unansweredQuestions
    ).toBe(2);
  });

  describe("completion and progress", () => {
    it("counts an enrollment complete only when every lesson is completed", () => {
      const first = createLesson(base.course.id);
      const second = createLesson(base.course.id);
      const finisher = createUser();
      const straggler = createUser();
      enroll(finisher.id, base.course.id);
      enroll(straggler.id, base.course.id);
      recordLessonProgress(finisher.id, first.id);
      recordLessonProgress(finisher.id, second.id);
      recordLessonProgress(straggler.id, first.id);
      recordLessonProgress(straggler.id, second.id, LessonProgressStatus.InProgress);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseStats(base.instructor.id, base.course.id)?.completionRate).toBe(50);
      expect(analytics.summary.completionRate).toBe(50);
      // (2/2 + 1/2) / 2 enrollments
      expect(analytics.summary.avgProgress).toBe(75);
    });

    it("rounds to whole-number percents", () => {
      const lessons = [1, 2, 3].map(() => createLesson(base.course.id));
      const students = [1, 2, 3].map(() => createUser());
      students.forEach((s) => enroll(s.id, base.course.id));
      lessons.forEach((l) => recordLessonProgress(students[0].id, l.id));
      recordLessonProgress(students[1].id, lessons[0].id);

      const analytics = getInstructorAnalytics(base.instructor.id);

      // 1 of 3 complete; progress (3/3 + 1/3 + 0) / 3
      expect(analytics.summary.completionRate).toBe(33);
      expect(analytics.summary.avgProgress).toBe(44);
    });

    it("ignores a lesson completed in another course", () => {
      createLesson(base.course.id);
      const elsewhere = createCourse(base.instructor.id);
      const otherLesson = createLesson(elsewhere.id);
      enroll(base.user.id, base.course.id);
      recordLessonProgress(base.user.id, otherLesson.id);

      expect(courseStats(base.instructor.id, base.course.id)?.completionRate).toBe(0);
    });

    it("never counts an enrollment in a zero-lesson course as complete", () => {
      enroll(base.user.id, base.course.id);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseStats(base.instructor.id, base.course.id)?.completionRate).toBe(0);
      expect(analytics.summary.completionRate).toBe(0);
      expect(analytics.summary.avgProgress).toBe(0);
    });

    it("returns null when a course or instructor has no enrollments", () => {
      const lesson = createLesson(base.course.id);
      recordLessonProgress(base.user.id, lesson.id);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseStats(base.instructor.id, base.course.id)?.completionRate).toBeNull();
      expect(analytics.summary.completionRate).toBeNull();
      expect(analytics.summary.avgProgress).toBeNull();
    });

    it("pools the summary across enrollments rather than averaging courses", () => {
      // Course A: 1 student, complete. Course B: 3 students, none complete.
      const lessonA = createLesson(base.course.id);
      enroll(base.user.id, base.course.id);
      recordLessonProgress(base.user.id, lessonA.id);
      const courseB = createCourse(base.instructor.id);
      createLesson(courseB.id);
      [1, 2, 3].forEach(() => enroll(createUser().id, courseB.id));

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(courseStats(base.instructor.id, base.course.id)?.completionRate).toBe(100);
      expect(courseStats(base.instructor.id, courseB.id)?.completionRate).toBe(0);
      expect(analytics.summary.completionRate).toBe(25);
      expect(analytics.summary.avgProgress).toBe(25);
    });

    it("excludes another instructor's students' progress", () => {
      const rival = createUser(UserRole.Instructor);
      const rivalCourse = createCourse(rival.id);
      const rivalLesson = createLesson(rivalCourse.id);
      const rivalStudent = createUser();
      enroll(rivalStudent.id, rivalCourse.id);
      recordLessonProgress(rivalStudent.id, rivalLesson.id);
      createLesson(base.course.id);
      enroll(base.user.id, base.course.id);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.summary.completionRate).toBe(0);
      expect(analytics.summary.avgProgress).toBe(0);
    });
  });
});
