import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { QuestionType } from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import {
  saveQuiz,
  getQuizByLessonId,
  getQuizWithQuestions,
  getAttemptsByUser,
  getAttemptWithAnswers,
  recordAttempt,
  recordAnswer,
} from "./quizService";

const twoQuestions = [
  {
    text: "What is 1 + 1?",
    type: QuestionType.MultipleChoice,
    options: [
      { text: "2", isCorrect: true },
      { text: "3", isCorrect: false },
    ],
  },
  {
    text: "The sky is blue.",
    type: QuestionType.TrueFalse,
    options: [
      { text: "True", isCorrect: true },
      { text: "False", isCorrect: false },
    ],
  },
];

// Re-expresses a stored quiz as saveQuiz input, carrying the stored ids.
function asSaveInput(quizId: number) {
  const quiz = getQuizWithQuestions(quizId)!;
  return quiz.questions.map((q) => ({
    id: q.id,
    text: q.questionText,
    type: q.questionType as QuestionType,
    options: q.options.map((o) => ({
      id: o.id,
      text: o.optionText,
      isCorrect: o.isCorrect,
    })),
  }));
}

// Records a student attempt answering every question with its first option.
function recordFirstOptionAttempt(quizId: number) {
  const quiz = getQuizWithQuestions(quizId)!;
  const attempt = recordAttempt(base.user.id, quizId, 1, true);
  for (const q of quiz.questions) {
    recordAnswer(attempt.id, q.id, q.options[0].id);
  }
  return attempt;
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module", position: 1 })
    .returning()
    .get();
  lessonId = testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "Lesson", position: 1 })
    .returning()
    .get().id;
});

describe("saveQuiz", () => {
  it("creates a quiz with its questions when the lesson has none", () => {
    const quiz = saveQuiz(lessonId, "Basics", 0.6, twoQuestions);

    const stored = getQuizWithQuestions(quiz.id)!;
    expect(stored.title).toBe("Basics");
    expect(stored.passingScore).toBe(0.6);
    expect(stored.questions.map((q) => q.questionText)).toEqual([
      "What is 1 + 1?",
      "The sky is blue.",
    ]);
    expect(stored.questions[0].options.map((o) => o.optionText)).toEqual([
      "2",
      "3",
    ]);
  });

  it("keeps students' attempts when the passing score is changed", () => {
    const quiz = saveQuiz(lessonId, "Basics", 0.7, twoQuestions);
    const attempt = recordFirstOptionAttempt(quiz.id);

    const saved = saveQuiz(lessonId, "Basics", 0.6, asSaveInput(quiz.id));

    expect(saved.id).toBe(quiz.id);
    expect(getQuizByLessonId(lessonId)!.passingScore).toBe(0.6);
    expect(getAttemptsByUser(base.user.id, quiz.id)).toHaveLength(1);
    expect(getAttemptWithAnswers(attempt.id)!.answers).toHaveLength(2);
  });

  it("updates edited questions and options in place", () => {
    const quiz = saveQuiz(lessonId, "Basics", 0.7, twoQuestions);
    const attempt = recordFirstOptionAttempt(quiz.id);
    const input = asSaveInput(quiz.id);
    input[0].text = "What is one plus one?";
    input[0].options[1].text = "Three";

    saveQuiz(lessonId, "Basics", 0.7, input);

    const stored = getQuizWithQuestions(quiz.id)!;
    expect(stored.questions[0].id).toBe(input[0].id);
    expect(stored.questions[0].questionText).toBe("What is one plus one?");
    expect(stored.questions[0].options.map((o) => o.optionText)).toEqual([
      "2",
      "Three",
    ]);
    expect(getAttemptWithAnswers(attempt.id)!.answers).toHaveLength(2);
  });

  it("removes deleted questions and only the answers to them", () => {
    const quiz = saveQuiz(lessonId, "Basics", 0.7, twoQuestions);
    const attempt = recordFirstOptionAttempt(quiz.id);
    const [kept, removed] = asSaveInput(quiz.id);

    saveQuiz(lessonId, "Basics", 0.7, [kept]);

    const stored = getQuizWithQuestions(quiz.id)!;
    expect(stored.questions.map((q) => q.id)).toEqual([kept.id]);
    const answers = getAttemptWithAnswers(attempt.id)!.answers;
    expect(answers.map((a) => a.questionId)).toEqual([kept.id]);
    expect(answers.map((a) => a.questionId)).not.toContain(removed.id);
  });

  it("removes deleted options and only the answers that chose them", () => {
    const quiz = saveQuiz(lessonId, "Basics", 0.7, twoQuestions);
    const attempt = recordFirstOptionAttempt(quiz.id);
    const input = asSaveInput(quiz.id);
    // Drop the option the attempt chose on question 1 ("2")
    input[0].options = [input[0].options[1]];

    saveQuiz(lessonId, "Basics", 0.7, input);

    const stored = getQuizWithQuestions(quiz.id)!;
    expect(stored.questions[0].options.map((o) => o.optionText)).toEqual(["3"]);
    const answers = getAttemptWithAnswers(attempt.id)!.answers;
    expect(answers.map((a) => a.questionId)).toEqual([input[1].id]);
  });

  it("adds new questions and stores them in the given order", () => {
    const quiz = saveQuiz(lessonId, "Basics", 0.7, twoQuestions);
    const [first, second] = asSaveInput(quiz.id);
    const added = {
      text: "Pick the even number.",
      type: QuestionType.MultipleChoice,
      options: [
        { text: "4", isCorrect: true },
        { text: "5", isCorrect: false },
      ],
    };

    saveQuiz(lessonId, "Basics", 0.7, [second, added, first]);

    const stored = getQuizWithQuestions(quiz.id)!;
    expect(stored.questions.map((q) => q.questionText)).toEqual([
      "The sky is blue.",
      "Pick the even number.",
      "What is 1 + 1?",
    ]);
  });

  it("saves a question whose id is repeated as a new question", () => {
    const quiz = saveQuiz(lessonId, "Basics", 0.7, twoQuestions);
    const [first] = asSaveInput(quiz.id);
    const copy = { ...first, text: "A copy" };

    saveQuiz(lessonId, "Basics", 0.7, [first, copy]);

    const stored = getQuizWithQuestions(quiz.id)!;
    expect(stored.questions.map((q) => q.questionText)).toEqual([
      "What is 1 + 1?",
      "A copy",
    ]);
  });

  it("treats ids from another quiz as new questions", () => {
    const otherLesson = testDb
      .insert(schema.lessons)
      .values({ moduleId: 1, title: "Other", position: 2 })
      .returning()
      .get();
    const other = saveQuiz(otherLesson.id, "Other", 0.7, twoQuestions);
    const quiz = saveQuiz(lessonId, "Basics", 0.7, twoQuestions);
    const foreign = asSaveInput(other.id);
    foreign[0].text = "Hijacked";

    saveQuiz(lessonId, "Basics", 0.7, [foreign[0]]);

    expect(getQuizWithQuestions(other.id)!.questions[0].questionText).toBe(
      "What is 1 + 1?"
    );
    const stored = getQuizWithQuestions(quiz.id)!;
    expect(stored.questions.map((q) => q.questionText)).toEqual(["Hijacked"]);
    expect(stored.questions[0].id).not.toBe(foreign[0].id);
  });
});
