import { countDistinct, eq, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  enrollments,
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
    avgQuizScore: number | null;
    quizPassRate: number | null;
  };
  courses: Array<{
    courseId: number;
    enrollments: number;
    revenueCents: number;
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
  const quizStatsByCourse = getQuizStatsByCourse(instructorId);
  const pooledQuizStats = poolQuizStats(quizStatsByCourse.values());

  return {
    summary: {
      uniqueStudents: getUniqueStudents(instructorId),
      revenueCents: sumValues(revenueByCourse),
      // Same definition as the instructor questions page the card links to.
      unansweredQuestions: getUnansweredQuestions(instructorId).length,
      avgQuizScore: avgQuizScore(pooledQuizStats),
      quizPassRate: quizPassRate(pooledQuizStats),
    },
    courses: ownCourses.map((course) => ({
      courseId: course.id,
      enrollments: enrollmentsByCourse.get(course.id) ?? 0,
      revenueCents: revenueByCourse.get(course.id) ?? 0,
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
