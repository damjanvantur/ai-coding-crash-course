import { and, count, countDistinct, eq, max, sql, sum } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
} from "~/db/schema";
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
    completionRate: number | null;
    avgProgress: number | null;
    avgQuizScore: number | null;
    quizPassRate: number | null;
  };
  courses: Array<{
    courseId: number;
    enrollments: number;
    revenueCents: number;
    completionRate: number | null;
    avgQuizScore: number | null;
  }>;
};

// Whole-number percent of `part` over `whole`; null when there is nothing to
// measure.
function percent(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 100);
}

export function getInstructorAnalytics(
  instructorId: number
): InstructorAnalytics {
  const ownCourse = eq(courses.instructorId, instructorId);

  const lessonTotals = db
    .select({
      courseId: modules.courseId,
      lessons: count(lessons.id).as("lessons"),
    })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(ownCourse)
    .groupBy(modules.courseId)
    .as("lesson_totals");

  // Lessons only — quizzes don't count, and the enrollment's own completedAt
  // is not trusted (see #3).
  const completedLessons = db
    .select({
      userId: lessonProgress.userId,
      courseId: modules.courseId,
      completed: countDistinct(lessonProgress.lessonId).as("completed"),
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(and(ownCourse, eq(lessonProgress.status, LessonProgressStatus.Completed)))
    .groupBy(lessonProgress.userId, modules.courseId)
    .as("completed_lessons");

  const courseLessonCount = sql`coalesce(${lessonTotals.lessons}, 0)`;
  const userCompletedCount = sql`coalesce(${completedLessons.completed}, 0)`;

  // One row per course, aggregated over its enrollments. Team-seat redemptions
  // create enrollments without purchases, so enrollments and revenue are
  // aggregated separately. A zero-lesson course is never complete and
  // contributes 0 progress.
  const enrollmentStats = db
    .select({
      courseId: enrollments.courseId,
      enrollments: count().as("enrollments"),
      completedEnrollments: sql<number>`sum(case when ${courseLessonCount} > 0 and ${userCompletedCount} >= ${courseLessonCount} then 1 else 0 end)`.as(
        "completed_enrollments"
      ),
      progressSum: sql<number>`sum(case when ${courseLessonCount} > 0 then cast(${userCompletedCount} as real) / ${courseLessonCount} else 0 end)`.as(
        "progress_sum"
      ),
    })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .leftJoin(lessonTotals, eq(lessonTotals.courseId, enrollments.courseId))
    .leftJoin(
      completedLessons,
      and(
        eq(completedLessons.userId, enrollments.userId),
        eq(completedLessons.courseId, enrollments.courseId)
      )
    )
    .where(ownCourse)
    .groupBy(enrollments.courseId)
    .as("enrollment_stats");

  // Amount paid already reflects PPP pricing and full team-purchase amounts.
  const revenueTotals = db
    .select({
      courseId: purchases.courseId,
      revenueCents: sum(purchases.amountPaid).as("revenue_cents"),
    })
    .from(purchases)
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .where(ownCourse)
    .groupBy(purchases.courseId)
    .as("revenue_totals");

  // One row per (student, quiz) pair: the best attempt's score, judged against
  // that quiz's own passing score. The stored `passed` flag is not trusted —
  // historical rows were graded against a wrong threshold (see #4).
  // courseId and passingScore are bare columns: both are fixed per quiz, and
  // the group is per quiz, so SQLite returns that quiz's single value.
  const bestAttempts = db
    .select({
      courseId: modules.courseId,
      passingScore: quizzes.passingScore,
      bestScore: max(quizAttempts.score).as("best_score"),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(ownCourse)
    .groupBy(quizAttempts.userId, quizAttempts.quizId)
    .as("best_attempts");

  const quizStats = db
    .select({
      courseId: bestAttempts.courseId,
      quizPairs: count().as("quiz_pairs"),
      bestScoreSum: sql<number>`sum(${bestAttempts.bestScore})`.as("best_score_sum"),
      quizPasses: sql<number>`sum(case when ${bestAttempts.bestScore} >= ${bestAttempts.passingScore} then 1 else 0 end)`.as(
        "quiz_passes"
      ),
    })
    .from(bestAttempts)
    .groupBy(bestAttempts.courseId)
    .as("quiz_stats");

  const courseRows = db
    .select({
      courseId: courses.id,
      enrollments: enrollmentStats.enrollments,
      completedEnrollments: enrollmentStats.completedEnrollments,
      progressSum: enrollmentStats.progressSum,
      revenueCents: revenueTotals.revenueCents,
      quizPairs: quizStats.quizPairs,
      bestScoreSum: quizStats.bestScoreSum,
      quizPasses: quizStats.quizPasses,
    })
    .from(courses)
    .leftJoin(enrollmentStats, eq(enrollmentStats.courseId, courses.id))
    .leftJoin(revenueTotals, eq(revenueTotals.courseId, courses.id))
    .leftJoin(quizStats, eq(quizStats.courseId, courses.id))
    .where(ownCourse)
    .all()
    .map((row) => ({
      courseId: row.courseId,
      enrollments: row.enrollments ?? 0,
      completedEnrollments: Number(row.completedEnrollments ?? 0),
      progressSum: Number(row.progressSum ?? 0),
      revenueCents: Number(row.revenueCents ?? 0),
      quizPairs: row.quizPairs ?? 0,
      bestScoreSum: Number(row.bestScoreSum ?? 0),
      quizPasses: Number(row.quizPasses ?? 0),
    }));

  // A student enrolled in several of the instructor's courses counts once.
  const studentTotals = db
    .select({ uniqueStudents: countDistinct(enrollments.userId) })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(ownCourse)
    .get();

  // Summary rates pool every enrollment (and every student-quiz pair), so
  // busier courses weigh more.
  const totals = courseRows.reduce(
    (acc, c) => ({
      enrollments: acc.enrollments + c.enrollments,
      completed: acc.completed + c.completedEnrollments,
      progress: acc.progress + c.progressSum,
      revenueCents: acc.revenueCents + c.revenueCents,
      quizPairs: acc.quizPairs + c.quizPairs,
      bestScoreSum: acc.bestScoreSum + c.bestScoreSum,
      quizPasses: acc.quizPasses + c.quizPasses,
    }),
    {
      enrollments: 0,
      completed: 0,
      progress: 0,
      revenueCents: 0,
      quizPairs: 0,
      bestScoreSum: 0,
      quizPasses: 0,
    }
  );

  return {
    summary: {
      uniqueStudents: studentTotals?.uniqueStudents ?? 0,
      revenueCents: totals.revenueCents,
      unansweredQuestions: getUnansweredQuestions(instructorId).length,
      completionRate: percent(totals.completed, totals.enrollments),
      avgProgress: percent(totals.progress, totals.enrollments),
      avgQuizScore: percent(totals.bestScoreSum, totals.quizPairs),
      quizPassRate: percent(totals.quizPasses, totals.quizPairs),
    },
    courses: courseRows.map((c) => ({
      courseId: c.courseId,
      enrollments: c.enrollments,
      revenueCents: c.revenueCents,
      completionRate: percent(c.completedEnrollments, c.enrollments),
      avgQuizScore: percent(c.bestScoreSum, c.quizPairs),
    })),
  };
}
