import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
  getSqlite() {
    return testDb.$client;
  },
}));

// Import after mock so the module picks up our test db
import {
  computeResult,
  getScore,
  getUserQuizHistory,
} from "./quizScoringService";

type SeededQuestion = { id: number; correctOptionId: number; wrongOptionId: number };

// Creates a quiz with `questionCount` multiple-choice questions, each with one
// correct and one wrong option.
function createQuiz(passingScore: number, questionCount: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module", position: 1 })
    .returning()
    .get();
  const lesson = testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "Lesson", position: 1 })
    .returning()
    .get();
  const quiz = testDb
    .insert(schema.quizzes)
    .values({ lessonId: lesson.id, title: "Quiz", passingScore })
    .returning()
    .get();

  const questions: SeededQuestion[] = [];
  for (let i = 0; i < questionCount; i++) {
    const question = testDb
      .insert(schema.quizQuestions)
      .values({
        quizId: quiz.id,
        questionText: `Question ${i + 1}`,
        questionType: schema.QuestionType.MultipleChoice,
        position: i + 1,
      })
      .returning()
      .get();
    const correct = testDb
      .insert(schema.quizOptions)
      .values({ questionId: question.id, optionText: "Right", isCorrect: true })
      .returning()
      .get();
    const wrong = testDb
      .insert(schema.quizOptions)
      .values({ questionId: question.id, optionText: "Wrong", isCorrect: false })
      .returning()
      .get();
    questions.push({
      id: question.id,
      correctOptionId: correct.id,
      wrongOptionId: wrong.id,
    });
  }

  return { quiz, questions };
}

// Answers the first `correctCount` questions correctly and the rest wrongly,
// keyed by question id (the shape `computeResult` takes).
function answerMap(questions: SeededQuestion[], correctCount: number) {
  const answers: Record<number, number> = {};
  questions.forEach((q, i) => {
    answers[q.id] = i < correctCount ? q.correctOptionId : q.wrongOptionId;
  });
  return answers;
}

// The same answers as `answerMap`, as the array `getScore` takes.
function answersAsArray(questions: SeededQuestion[], correctCount: number) {
  return Object.entries(answerMap(questions, correctCount)).map(
    ([questionId, selectedOptionId]) => ({
      questionId: Number(questionId),
      selectedOptionId,
    })
  );
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

describe("computeResult", () => {
  it("passes an attempt that scores exactly the quiz's passing score", () => {
    const { quiz, questions } = createQuiz(0.6, 5);

    const result = computeResult(base.user.id, quiz.id, answerMap(questions, 3));

    expect(result.score).toBe(0.6);
    expect(result.passed).toBe(true);
  });

  it("fails an attempt that scores just below the quiz's passing score", () => {
    const { quiz, questions } = createQuiz(0.61, 5);

    const result = computeResult(base.user.id, quiz.id, answerMap(questions, 3));

    expect(result.score).toBe(0.6);
    expect(result.passed).toBe(false);
  });

  it("fails a 75% attempt on a quiz with an 80% passing score", () => {
    const { quiz, questions } = createQuiz(0.8, 4);

    const result = computeResult(base.user.id, quiz.id, answerMap(questions, 3));

    expect(result.score).toBe(0.75);
    expect(result.passed).toBe(false);
  });
  it("records the pass/fail outcome on the stored attempt", () => {
    const { quiz, questions } = createQuiz(0.6, 5);

    computeResult(base.user.id, quiz.id, answerMap(questions, 3));
    computeResult(base.user.id, quiz.id, answerMap(questions, 2));

    const history = getUserQuizHistory(base.user.id, quiz.id);
    expect(
      history.map((h: { score: number; passed: boolean }) => [h.score, h.passed])
    ).toEqual(expect.arrayContaining([[0.6, true], [0.4, false]]));
    expect(history).toHaveLength(2);
  });
});

describe("getScore", () => {
  it("passes a score exactly at the quiz's passing score", () => {
    const { quiz, questions } = createQuiz(0.6, 5);

    const result = getScore(quiz.id, answersAsArray(questions, 3));

    expect(result.score).toBe(0.6);
    expect(result.passed).toBe(true);
  });

  it("fails a score just below the quiz's passing score", () => {
    const { quiz, questions } = createQuiz(0.61, 5);

    const result = getScore(quiz.id, answersAsArray(questions, 3));

    expect(result.score).toBe(0.6);
    expect(result.passed).toBe(false);
  });

  it("fails a 75% score on a quiz with an 80% passing score", () => {
    const { quiz, questions } = createQuiz(0.8, 4);

    const result = getScore(quiz.id, answersAsArray(questions, 3));

    expect(result.score).toBe(0.75);
    expect(result.passed).toBe(false);
  });
});
