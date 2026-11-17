import { count, countDistinct, eq, sum } from "drizzle-orm";
import { db } from "~/db";
import { courses, enrollments, purchases } from "~/db/schema";
import { getUnansweredQuestions } from "~/services/commentService";

// ─── Instructor Analytics Service ───
// Everything the My Courses dashboard shows about an instructor's own courses,
// all-time and across every course status. Each metric is one aggregate query
// per instructor, never a loop over students.

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
  // Team-seat redemptions create enrollments without purchases, so enrollments
  // and revenue are aggregated separately. Both are scoped to the instructor's
  // courses so the cost tracks their courses, not the whole platform.
  const enrollmentCounts = db
    .select({
      courseId: enrollments.courseId,
      enrollments: count().as("enrollments"),
    })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(eq(courses.instructorId, instructorId))
    .groupBy(enrollments.courseId)
    .as("enrollment_counts");

  // Amount paid already reflects PPP pricing and full team-purchase amounts.
  const revenueTotals = db
    .select({
      courseId: purchases.courseId,
      revenueCents: sum(purchases.amountPaid).as("revenue_cents"),
    })
    .from(purchases)
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .where(eq(courses.instructorId, instructorId))
    .groupBy(purchases.courseId)
    .as("revenue_totals");

  const courseRows = db
    .select({
      courseId: courses.id,
      enrollments: enrollmentCounts.enrollments,
      revenueCents: revenueTotals.revenueCents,
    })
    .from(courses)
    .leftJoin(enrollmentCounts, eq(enrollmentCounts.courseId, courses.id))
    .leftJoin(revenueTotals, eq(revenueTotals.courseId, courses.id))
    .where(eq(courses.instructorId, instructorId))
    .all()
    .map((row) => ({
      courseId: row.courseId,
      enrollments: row.enrollments ?? 0,
      revenueCents: Number(row.revenueCents ?? 0),
    }));

  // A student enrolled in several of the instructor's courses counts once.
  const studentTotals = db
    .select({ uniqueStudents: countDistinct(enrollments.userId) })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(eq(courses.instructorId, instructorId))
    .get();

  return {
    summary: {
      uniqueStudents: studentTotals?.uniqueStudents ?? 0,
      revenueCents: courseRows.reduce((total, c) => total + c.revenueCents, 0),
      unansweredQuestions: getUnansweredQuestions(instructorId).length,
    },
    courses: courseRows,
  };
}
