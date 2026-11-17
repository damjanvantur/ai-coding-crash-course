import { countDistinct, eq, sql } from "drizzle-orm";
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
  const completionByCourse = getCompletionByCourse(instructorId);
  const completionTotals = sumCompletion(completionByCourse.values());
  const quizStatsByCourse = getQuizStatsByCourse(instructorId);
  const pooledQuizStats = poolQuizStats(quizStatsByCourse.values());

  return {
    summary: {
      uniqueStudents: getUniqueStudents(instructorId),
      revenueCents: sumValues(revenueByCourse),
      // Same definition as the instructor questions page the card links to.
      unansweredQuestions: getUnansweredQuestions(instructorId).length,
      completionRate: completionRate(completionTotals),
      avgProgress: avgProgress(completionTotals),
      avgQuizScore: avgQuizScore(pooledQuizStats),
      quizPassRate: quizPassRate(pooledQuizStats),
    },
    courses: ownCourses.map((course) => ({
      courseId: course.id,
      enrollments: enrollmentsByCourse.get(course.id) ?? 0,
      revenueCents: revenueByCourse.get(course.id) ?? 0,
      completionRate: completionRate(completionByCourse.get(course.id)),
      avgQuizScore: avgQuizScore(quizStatsByCourse.get(course.id)),
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

// ─── Completion ───
// Lessons only (quizzes don't count). The enrollment's stored completedAt is
// ignored: the app never set it for historical rows.

// progressSum adds up each enrollment's completed ÷ total lessons (0..1).
type CompletionTotals = {
  enrollments: number;
  completed: number;
  progressSum: number;
};

// One row per course: enrollments, how many have every lesson completed, and
// the summed per-enrollment progress. A zero-lesson course never counts as
// complete and contributes 0 progress.
function getCompletionByCourse(instructorId: number) {
  const courseLessons = db
    .select({ courseId: modules.courseId, lessonId: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .as("course_lessons");

  const perEnrollment = db
    .select({
      courseId: enrollments.courseId,
      totalLessons: sql<number>`(
        select count(*) from ${courseLessons}
        where ${courseLessons.courseId} = ${enrollments.courseId}
      )`.as("total_lessons"),
      completedLessons: sql<number>`(
        select count(distinct ${lessonProgress.lessonId})
        from ${lessonProgress}
        inner join ${courseLessons}
          on ${courseLessons.lessonId} = ${lessonProgress.lessonId}
        where ${courseLessons.courseId} = ${enrollments.courseId}
          and ${lessonProgress.userId} = ${enrollments.userId}
          and ${lessonProgress.status} = ${LessonProgressStatus.Completed}
      )`.as("completed_lessons"),
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(eq(courses.instructorId, instructorId))
    .as("per_enrollment");

  const rows = db
    .select({
      courseId: perEnrollment.courseId,
      enrollments: sql<number>`count(*)`,
      completed: sql<number>`sum(case when ${perEnrollment.totalLessons} > 0
        and ${perEnrollment.completedLessons} = ${perEnrollment.totalLessons}
        then 1 else 0 end)`,
      progressSum: sql<number>`sum(case when ${perEnrollment.totalLessons} > 0
        then cast(${perEnrollment.completedLessons} as real)
          / ${perEnrollment.totalLessons}
        else 0 end)`,
    })
    .from(perEnrollment)
    .groupBy(perEnrollment.courseId)
    .all();

  return new Map<number, CompletionTotals>(
    rows.map((row) => [
      row.courseId,
      {
        enrollments: Number(row.enrollments),
        completed: Number(row.completed),
        progressSum: Number(row.progressSum),
      },
    ])
  );
}

// Pooled across enrollments, so a course with more students weighs more.
function sumCompletion(perCourse: Iterable<CompletionTotals>): CompletionTotals {
  const total = { enrollments: 0, completed: 0, progressSum: 0 };
  for (const course of perCourse) {
    total.enrollments += course.enrollments;
    total.completed += course.completed;
    total.progressSum += course.progressSum;
  }
  return total;
}

function completionRate(totals: CompletionTotals | undefined) {
  if (!totals || totals.enrollments === 0) return null;
  return Math.round((totals.completed / totals.enrollments) * 100);
}

function avgProgress(totals: CompletionTotals) {
  if (totals.enrollments === 0) return null;
  return Math.round((totals.progressSum / totals.enrollments) * 100);
}

// ─── Quizzes ───

// Totals over (student, quiz) pairs, each represented by its best attempt.
// A pair passes when its best score reaches that quiz's own passing score; the
// stored `passed` flag is ignored because historical rows used a wrong threshold.
type QuizStats = { pairs: number; bestScoreSum: number; passedPairs: number };

function getQuizStatsByCourse(instructorId: number) {
  const best = db
    .select({
      quizId: quizAttempts.quizId,
      bestScore: sql<number>`max(${quizAttempts.score})`.as("best_score"),
    })
    .from(quizAttempts)
    .groupBy(quizAttempts.userId, quizAttempts.quizId)
    .as("best");

  const rows = db
    .select({
      courseId: modules.courseId,
      pairs: sql<number>`count(*)`,
      bestScoreSum: sql<number>`sum(${best.bestScore})`,
      passedPairs: sql<number>`sum(case when ${best.bestScore} >= ${quizzes.passingScore} then 1 else 0 end)`,
    })
    .from(best)
    .innerJoin(quizzes, eq(best.quizId, quizzes.id))
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(courses.instructorId, instructorId))
    .groupBy(modules.courseId)
    .all();

  return new Map<number, QuizStats>(
    rows.map((row) => [
      row.courseId,
      {
        pairs: Number(row.pairs),
        bestScoreSum: Number(row.bestScoreSum),
        passedPairs: Number(row.passedPairs),
      },
    ])
  );
}

function poolQuizStats(stats: Iterable<QuizStats>): QuizStats {
  const pooled = { pairs: 0, bestScoreSum: 0, passedPairs: 0 };
  for (const s of stats) {
    pooled.pairs += s.pairs;
    pooled.bestScoreSum += s.bestScoreSum;
    pooled.passedPairs += s.passedPairs;
  }
  return pooled;
}

// Scores are stored as 0–1 fractions; the dashboard shows whole percents.
function avgQuizScore(stats: QuizStats | undefined) {
  if (!stats || stats.pairs === 0) return null;
  return Math.round((stats.bestScoreSum / stats.pairs) * 100);
}

// Denominator is students who attempted, not everyone enrolled.
function quizPassRate(stats: QuizStats) {
  if (stats.pairs === 0) return null;
  return Math.round((stats.passedPairs / stats.pairs) * 100);
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
