import { eq, and, sql, desc } from "drizzle-orm";
import { db } from "~/db";
import {
  quizzes,
  quizQuestions,
  quizOptions,
  quizAttempts,
  quizAnswers,
  QuestionType,
} from "~/db/schema";

// ─── Quiz Service ───
// Handles quiz CRUD, question/option management, and attempt recording.
// Uses positional parameters (project convention).

// ─── Quiz CRUD ───

export function getQuizById(id: number) {
  return db.select().from(quizzes).where(eq(quizzes.id, id)).get();
}

export function getQuizByLessonId(lessonId: number) {
  return db.select().from(quizzes).where(eq(quizzes.lessonId, lessonId)).get();
}

export function getQuizWithQuestions(quizId: number) {
  const quiz = getQuizById(quizId);
  if (!quiz) return null;

  const questions = db
    .select()
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId))
    .orderBy(quizQuestions.position)
    .all();

  const questionsWithOptions = questions.map((question) => {
    const options = db
      .select()
      .from(quizOptions)
      .where(eq(quizOptions.questionId, question.id))
      .all();
    return { ...question, options };
  });

  return { ...quiz, questions: questionsWithOptions };
}

export function createQuiz(
  lessonId: number,
  title: string,
  passingScore: number
) {
  return db
    .insert(quizzes)
    .values({ lessonId, title, passingScore })
    .returning()
    .get();
}

export function updateQuiz(
  id: number,
  title: string | null,
  passingScore: number | null
) {
  const updates: Record<string, unknown> = {};
  if (title !== null) updates.title = title;
  if (passingScore !== null) updates.passingScore = passingScore;

  if (Object.keys(updates).length === 0) {
    return getQuizById(id);
  }

  return db
    .update(quizzes)
    .set(updates)
    .where(eq(quizzes.id, id))
    .returning()
    .get();
}

export function deleteQuiz(id: number) {
  // Cascade: delete answers -> attempts -> options -> questions -> quiz
  const questions = getQuestionsByQuiz(id);
  for (const question of questions) {
    db.delete(quizOptions).where(eq(quizOptions.questionId, question.id)).run();
  }

  const attempts = db
    .select()
    .from(quizAttempts)
    .where(eq(quizAttempts.quizId, id))
    .all();
  for (const attempt of attempts) {
    db.delete(quizAnswers).where(eq(quizAnswers.attemptId, attempt.id)).run();
  }

  db.delete(quizAttempts).where(eq(quizAttempts.quizId, id)).run();
  db.delete(quizQuestions).where(eq(quizQuestions.quizId, id)).run();
  return db.delete(quizzes).where(eq(quizzes.id, id)).returning().get();
}

// ─── Saving a Whole Quiz ───

export interface SaveQuizOption {
  id?: number;
  text: string;
  isCorrect: boolean;
}

export interface SaveQuizQuestion {
  id?: number;
  text: string;
  type: QuestionType;
  options: SaveQuizOption[];
}

// Saves a lesson's quiz from the full set of questions an instructor submitted.
// An existing quiz is updated in place so students' attempts survive: questions
// and options with a known id are edited, ones without are added, and ones left
// out are removed along with only the answers that pointed at them. Ids that
// don't belong to this quiz, or repeat one already used, are treated as new.
export function saveQuiz(
  lessonId: number,
  title: string,
  passingScore: number,
  questions: SaveQuizQuestion[]
) {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(quizzes)
      .where(eq(quizzes.lessonId, lessonId))
      .get();

    const quiz = existing
      ? tx
          .update(quizzes)
          .set({ title, passingScore })
          .where(eq(quizzes.id, existing.id))
          .returning()
          .get()
      : tx
          .insert(quizzes)
          .values({ lessonId, title, passingScore })
          .returning()
          .get();

    const storedQuestionIds = new Set(
      tx
        .select({ id: quizQuestions.id })
        .from(quizQuestions)
        .where(eq(quizQuestions.quizId, quiz.id))
        .all()
        .map((q) => q.id)
    );

    const keptQuestionIds = new Set<number>();
    questions.forEach((q, index) => {
      const position = index + 1;
      let questionId: number;

      if (
        q.id !== undefined &&
        storedQuestionIds.has(q.id) &&
        !keptQuestionIds.has(q.id)
      ) {
        questionId = q.id;
        tx.update(quizQuestions)
          .set({ questionText: q.text, questionType: q.type, position })
          .where(eq(quizQuestions.id, questionId))
          .run();
      } else {
        questionId = tx
          .insert(quizQuestions)
          .values({
            quizId: quiz.id,
            questionText: q.text,
            questionType: q.type,
            position,
          })
          .returning()
          .get().id;
      }
      keptQuestionIds.add(questionId);

      const storedOptionIds = new Set(
        tx
          .select({ id: quizOptions.id })
          .from(quizOptions)
          .where(eq(quizOptions.questionId, questionId))
          .all()
          .map((o) => o.id)
      );
      const keptOptionIds = new Set<number>();
      for (const opt of q.options) {
        if (
          opt.id !== undefined &&
          storedOptionIds.has(opt.id) &&
          !keptOptionIds.has(opt.id)
        ) {
          tx.update(quizOptions)
            .set({ optionText: opt.text, isCorrect: opt.isCorrect })
            .where(eq(quizOptions.id, opt.id))
            .run();
          keptOptionIds.add(opt.id);
        } else {
          tx.insert(quizOptions)
            .values({ questionId, optionText: opt.text, isCorrect: opt.isCorrect })
            .run();
        }
      }

      for (const optionId of storedOptionIds) {
        if (keptOptionIds.has(optionId)) continue;
        tx.delete(quizAnswers)
          .where(eq(quizAnswers.selectedOptionId, optionId))
          .run();
        tx.delete(quizOptions).where(eq(quizOptions.id, optionId)).run();
      }
    });

    for (const questionId of storedQuestionIds) {
      if (keptQuestionIds.has(questionId)) continue;
      tx.delete(quizAnswers)
        .where(eq(quizAnswers.questionId, questionId))
        .run();
      tx.delete(quizOptions)
        .where(eq(quizOptions.questionId, questionId))
        .run();
      tx.delete(quizQuestions).where(eq(quizQuestions.id, questionId)).run();
    }

    return quiz;
  });
}

// ─── Question Management ───

export function getQuestionById(id: number) {
  return db.select().from(quizQuestions).where(eq(quizQuestions.id, id)).get();
}

export function getQuestionsByQuiz(quizId: number) {
  return db
    .select()
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId))
    .orderBy(quizQuestions.position)
    .all();
}

export function getQuestionCount(quizId: number) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId))
    .get();
  return result?.count ?? 0;
}

export function createQuestion(
  quizId: number,
  questionText: string,
  questionType: QuestionType,
  position: number | null
) {
  const pos =
    position ??
    db
      .select({
        max: sql<number>`coalesce(max(${quizQuestions.position}), 0)`,
      })
      .from(quizQuestions)
      .where(eq(quizQuestions.quizId, quizId))
      .get()!.max + 1;

  return db
    .insert(quizQuestions)
    .values({ quizId, questionText, questionType, position: pos })
    .returning()
    .get();
}

export function updateQuestion(
  id: number,
  questionText: string | null,
  questionType: QuestionType | null
) {
  const updates: Record<string, unknown> = {};
  if (questionText !== null) updates.questionText = questionText;
  if (questionType !== null) updates.questionType = questionType;

  if (Object.keys(updates).length === 0) {
    return getQuestionById(id);
  }

  return db
    .update(quizQuestions)
    .set(updates)
    .where(eq(quizQuestions.id, id))
    .returning()
    .get();
}

export function deleteQuestion(id: number) {
  db.delete(quizOptions).where(eq(quizOptions.questionId, id)).run();
  return db
    .delete(quizQuestions)
    .where(eq(quizQuestions.id, id))
    .returning()
    .get();
}

// ─── Question Reordering ───

export function moveQuestionToPosition(
  questionId: number,
  newPosition: number
) {
  const question = getQuestionById(questionId);
  if (!question) return null;

  const oldPosition = question.position;
  if (oldPosition === newPosition) return question;

  if (newPosition > oldPosition) {
    db.update(quizQuestions)
      .set({ position: sql`${quizQuestions.position} - 1` })
      .where(
        and(
          eq(quizQuestions.quizId, question.quizId),
          sql`${quizQuestions.position} > ${oldPosition}`,
          sql`${quizQuestions.position} <= ${newPosition}`
        )
      )
      .run();
  } else {
    db.update(quizQuestions)
      .set({ position: sql`${quizQuestions.position} + 1` })
      .where(
        and(
          eq(quizQuestions.quizId, question.quizId),
          sql`${quizQuestions.position} >= ${newPosition}`,
          sql`${quizQuestions.position} < ${oldPosition}`
        )
      )
      .run();
  }

  return db
    .update(quizQuestions)
    .set({ position: newPosition })
    .where(eq(quizQuestions.id, questionId))
    .returning()
    .get();
}

export function reorderQuestions(quizId: number, questionIds: number[]) {
  for (let i = 0; i < questionIds.length; i++) {
    db.update(quizQuestions)
      .set({ position: i + 1 })
      .where(
        and(
          eq(quizQuestions.id, questionIds[i]),
          eq(quizQuestions.quizId, quizId)
        )
      )
      .run();
  }
  return getQuestionsByQuiz(quizId);
}

// ─── Option Management ───

export function getOptionById(id: number) {
  return db.select().from(quizOptions).where(eq(quizOptions.id, id)).get();
}

export function getOptionsByQuestion(questionId: number) {
  return db
    .select()
    .from(quizOptions)
    .where(eq(quizOptions.questionId, questionId))
    .all();
}

export function createOption(
  questionId: number,
  optionText: string,
  isCorrect: boolean
) {
  return db
    .insert(quizOptions)
    .values({ questionId, optionText, isCorrect })
    .returning()
    .get();
}

export function updateOption(
  id: number,
  optionText: string | null,
  isCorrect: boolean | null
) {
  const updates: Record<string, unknown> = {};
  if (optionText !== null) updates.optionText = optionText;
  if (isCorrect !== null) updates.isCorrect = isCorrect;

  if (Object.keys(updates).length === 0) {
    return getOptionById(id);
  }

  return db
    .update(quizOptions)
    .set(updates)
    .where(eq(quizOptions.id, id))
    .returning()
    .get();
}

export function deleteOption(id: number) {
  return db.delete(quizOptions).where(eq(quizOptions.id, id)).returning().get();
}

// ─── Attempt Recording ───

export function getAttemptById(id: number) {
  return db.select().from(quizAttempts).where(eq(quizAttempts.id, id)).get();
}

export function getAttemptsByUser(userId: number, quizId: number) {
  return db
    .select()
    .from(quizAttempts)
    .where(
      and(eq(quizAttempts.userId, userId), eq(quizAttempts.quizId, quizId))
    )
    .orderBy(desc(quizAttempts.attemptedAt))
    .all();
}

export function getAttemptCountForQuiz(quizId: number) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(quizAttempts)
    .where(eq(quizAttempts.quizId, quizId))
    .get();
  return result?.count ?? 0;
}

export function getBestAttempt(userId: number, quizId: number) {
  return db
    .select()
    .from(quizAttempts)
    .where(
      and(eq(quizAttempts.userId, userId), eq(quizAttempts.quizId, quizId))
    )
    .orderBy(desc(quizAttempts.score))
    .limit(1)
    .get();
}

export function getLatestAttempt(userId: number, quizId: number) {
  return db
    .select()
    .from(quizAttempts)
    .where(
      and(eq(quizAttempts.userId, userId), eq(quizAttempts.quizId, quizId))
    )
    .orderBy(desc(quizAttempts.attemptedAt))
    .limit(1)
    .get();
}

export function recordAttempt(
  userId: number,
  quizId: number,
  score: number,
  passed: boolean
) {
  return db
    .insert(quizAttempts)
    .values({ userId, quizId, score, passed })
    .returning()
    .get();
}

export function recordAnswer(
  attemptId: number,
  questionId: number,
  selectedOptionId: number
) {
  return db
    .insert(quizAnswers)
    .values({ attemptId, questionId, selectedOptionId })
    .returning()
    .get();
}

export function getAnswersByAttempt(attemptId: number) {
  return db
    .select()
    .from(quizAnswers)
    .where(eq(quizAnswers.attemptId, attemptId))
    .all();
}

export function getAttemptWithAnswers(attemptId: number) {
  const attempt = getAttemptById(attemptId);
  if (!attempt) return null;

  const answers = getAnswersByAttempt(attemptId);
  return { ...attempt, answers };
}
