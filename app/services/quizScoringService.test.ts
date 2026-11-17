import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import { computeResult } from "./quizScoringService";

// Creates a quiz of true/false questions and returns answers that get
// `correctCount` of them right and the rest wrong.
function createQuizWithAnswers(
  passingScore: number,
  questionCount: number,
  correctCount: number
) {
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

  const answers: Record<number, number> = {};
  for (let i = 0; i < questionCount; i++) {
    const question = testDb
      .insert(schema.quizQuestions)
      .values({
        quizId: quiz.id,
        questionText: `Question ${i + 1}`,
        questionType: schema.QuestionType.TrueFalse,
        position: i + 1,
      })
      .returning()
      .get();
    const right = testDb
      .insert(schema.quizOptions)
      .values({ questionId: question.id, optionText: "True", isCorrect: true })
      .returning()
      .get();
    const wrong = testDb
      .insert(schema.quizOptions)
      .values({ questionId: question.id, optionText: "False", isCorrect: false })
      .returning()
      .get();
    answers[question.id] = i < correctCount ? right.id : wrong.id;
  }

  return { quiz, answers };
}

describe("computeResult", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("passes an attempt that scores exactly the quiz's passing score", () => {
    const { quiz, answers } = createQuizWithAnswers(0.6, 5, 3);

    const result = computeResult(base.user.id, quiz.id, answers);

    expect(result.score).toBe(0.6);
    expect(result.passed).toBe(true);
  });

  it("fails an attempt that scores just below the quiz's passing score", () => {
    const { quiz, answers } = createQuizWithAnswers(0.6, 7, 4);

    const result = computeResult(base.user.id, quiz.id, answers);

    expect(result.score).toBeCloseTo(4 / 7);
    expect(result.passed).toBe(false);
  });

  it("fails a 75% attempt on a quiz whose passing score is 80%", () => {
    const { quiz, answers } = createQuizWithAnswers(0.8, 4, 3);

    const result = computeResult(base.user.id, quiz.id, answers);

    expect(result.score).toBe(0.75);
    expect(result.passed).toBe(false);
  });
});
