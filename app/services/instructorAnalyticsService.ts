import { countDistinct, eq, sql } from "drizzle-orm";
import { db } from "~/db";
import { courses, enrollments, purchases } from "~/db/schema";
import { getUnansweredQuestions } from "./commentService";

// ─── Instructor Analytics Service ───
// Everything the My Courses dashboard renders for one instructor, computed
// with aggregate queries over all of their courses (any status, all-time).
// Each per-course metric is one grouped query keyed by course id, merged onto
// the instructor's course list; per-student loops are deliberately avoided so
// the page stays fast as enrollments grow.

export type InstructorAnalytics = {
  summary: {
    uniqueStudents: number;
    revenueCents: number;
    unansweredQuestions: number;
  };
  courses: Array<{
    courseId: number;
    enrollments: number;
    revenueCents: number;
  }>;
};

export function getInstructorAnalytics(
  instructorId: number
): InstructorAnalytics {
  const ownCourses = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.instructorId, instructorId))
    .all();

  const enrollmentsByCourse = getEnrollmentsByCourse(instructorId);
  const revenueByCourse = getRevenueByCourse(instructorId);

  return {
    summary: {
      uniqueStudents: getUniqueStudents(instructorId),
      revenueCents: sumValues(revenueByCourse),
      // Same definition as the instructor questions page the card links to.
      unansweredQuestions: getUnansweredQuestions(instructorId).length,
    },
    courses: ownCourses.map((course) => ({
      courseId: course.id,
      enrollments: enrollmentsByCourse.get(course.id) ?? 0,
      revenueCents: revenueByCourse.get(course.id) ?? 0,
    })),
  };
}

// ─── Students ───

// Every enrollment counts, including team-seat redemptions (no purchase).
function getEnrollmentsByCourse(instructorId: number) {
  return toCourseMap(
    db
      .select({ courseId: enrollments.courseId, value: sql<number>`count(*)` })
      .from(enrollments)
      .innerJoin(courses, eq(enrollments.courseId, courses.id))
      .where(eq(courses.instructorId, instructorId))
      .groupBy(enrollments.courseId)
      .all()
  );
}

// Distinct across courses: a student in two courses counts once.
function getUniqueStudents(instructorId: number) {
  const row = db
    .select({ value: countDistinct(enrollments.userId) })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(eq(courses.instructorId, instructorId))
    .get();
  return Number(row?.value ?? 0);
}

// ─── Revenue ───

// amountPaid already reflects PPP pricing and a team purchase's full amount.
function getRevenueByCourse(instructorId: number) {
  return toCourseMap(
    db
      .select({
        courseId: purchases.courseId,
        value: sql<number>`sum(${purchases.amountPaid})`,
      })
      .from(purchases)
      .innerJoin(courses, eq(purchases.courseId, courses.id))
      .where(eq(courses.instructorId, instructorId))
      .groupBy(purchases.courseId)
      .all()
  );
}

// ─── Helpers ───

function toCourseMap(rows: Array<{ courseId: number; value: number }>) {
  return new Map(rows.map((row) => [row.courseId, Number(row.value)]));
}

function sumValues(map: Map<number, number>) {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}
