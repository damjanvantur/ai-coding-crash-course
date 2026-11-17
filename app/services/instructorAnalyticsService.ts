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

// A whole percent, or null when it is not computable (nothing to divide by),
// which the dashboard shows differently from 0%.
export type Percent = number | null;

export type InstructorAnalytics = {
  summary: {
    uniqueStudents: number;
    revenueCents: number;
    unansweredQuestions: number;
    completionRate: Percent;
    avgProgress: Percent;
    avgQuizScore: Percent;
    quizPassRate: Percent;
  };
  // One entry per instructor course, with zero/null defaults filled in.
  courses: Array<{
    courseId: number;
    lessonCount: number;
    enrollments: number;
    revenueCents: number;
    completionRate: Percent;
    avgQuizScore: Percent;
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

  const lessonCountByCourse = getLessonCountByCourse(instructorId);
  const enrollmentsByCourse = getEnrollmentsByCourse(instructorId);
  const revenueByCourse = getRevenueByCourse(instructorId);
  const completionByCourse = getCompletionByCourse(instructorId);
  const completionTotals = sumFields(
    completionByCourse.values(),
    EMPTY_COMPLETION
  );
  const quizStatsByCourse = getQuizStatsByCourse(instructorId);
  const pooledQuizStats = sumFields(quizStatsByCourse.values(), EMPTY_QUIZ_STATS);

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
      lessonCount: lessonCountByCourse.get(course.id) ?? 0,
      enrollments: enrollmentsByCourse.get(course.id) ?? 0,
      revenueCents: revenueByCourse.get(course.id) ?? 0,
      completionRate: completionRate(completionByCourse.get(course.id)),
      avgQuizScore: avgQuizScore(quizStatsByCourse.get(course.id)),
    })),
  };
}

// ─── Lessons ───

function getLessonCountByCourse(instructorId: number) {
  return toCourseMap(
    db
      .select({ courseId: modules.courseId, value: sql<number>`count(*)` })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .innerJoin(courses, eq(modules.courseId, courses.id))
      .where(eq(courses.instructorId, instructorId))
      .groupBy(modules.courseId)
      .all()
  );
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

// progressSum adds up each enrollment's completed ÷ total lessons (0..1) over
// the progressEnrollments that have a computable progress. A zero-lesson
// course's enrollments count in enrollments (never complete) but not in
// progressEnrollments: 0/0 is not 0% progress.
type CompletionTotals = {
  enrollments: number;
  completed: number;
  progressEnrollments: number;
  progressSum: number;
};

const EMPTY_COMPLETION: CompletionTotals = {
  enrollments: 0,
  completed: 0,
  progressEnrollments: 0,
  progressSum: 0,
};
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
      progressEnrollments: sql<number>`sum(case when ${perEnrollment.totalLessons} > 0
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
        progressEnrollments: Number(row.progressEnrollments),
        progressSum: Number(row.progressSum),
      },
    ])
  );
}

function completionRate(totals = EMPTY_COMPLETION) {
  return percentOrNull(totals.completed, totals.enrollments);
}

function avgProgress(totals: CompletionTotals) {
  return percentOrNull(totals.progressSum, totals.progressEnrollments);
}

// ─── Quizzes ───

// Totals over (student, quiz) pairs, each represented by its best attempt.
// A pair passes when its best score reaches that quiz's own passing score; the
// stored `passed` flag is ignored because historical rows used a wrong threshold.
type QuizStats = { pairs: number; bestScoreSum: number; passedPairs: number };

const EMPTY_QUIZ_STATS: QuizStats = { pairs: 0, bestScoreSum: 0, passedPairs: 0 };

function getQuizStatsByCourse(instructorId: number) {
  const bestAttempts = db
    .select({
      quizId: quizAttempts.quizId,
      bestScore: sql<number>`max(${quizAttempts.score})`.as("best_score"),
    })
    .from(quizAttempts)
    .groupBy(quizAttempts.userId, quizAttempts.quizId)
    .as("best_attempts");

  const rows = db
    .select({
      courseId: modules.courseId,
      pairs: sql<number>`count(*)`,
      bestScoreSum: sql<number>`sum(${bestAttempts.bestScore})`,
      passedPairs: sql<number>`sum(case when ${bestAttempts.bestScore} >= ${quizzes.passingScore} then 1 else 0 end)`,
    })
    .from(bestAttempts)
    .innerJoin(quizzes, eq(bestAttempts.quizId, quizzes.id))
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

// Scores are stored as 0–1 fractions; the dashboard shows whole percents.
function avgQuizScore(stats = EMPTY_QUIZ_STATS) {
  return percentOrNull(stats.bestScoreSum, stats.pairs);
}

// Denominator is students who attempted, not everyone enrolled.
function quizPassRate(stats: QuizStats) {
  return percentOrNull(stats.passedPairs, stats.pairs);
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

// Field-wise sum of per-course totals. Pooling the raw counts (not averaging
// per-course percents) weighs a course with more students more.
function sumFields<T extends Record<string, number>>(
  rows: Iterable<T>,
  empty: T
): T {
  const total = { ...empty };
  for (const row of rows) {
    for (const key of Object.keys(total) as Array<keyof T>) {
      total[key] = (total[key] + row[key]) as T[keyof T];
    }
  }
  return total;
}

function percentOrNull(numerator: number, denominator: number): Percent {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 100);
}
