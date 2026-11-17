import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { CourseStatus, UserRole } from "~/db/schema";

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
      summary: { uniqueStudents: 0, revenueCents: 0, unansweredQuestions: 0 },
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
});
