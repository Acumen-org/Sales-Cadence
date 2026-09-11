import { z } from 'zod';

export const ACTION_TYPES = ['EMAIL', 'CALL', 'LINKEDIN_CONNECT', 'LINKEDIN_MESSAGE'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const ActionTypeSchema = z.enum(ACTION_TYPES);

export const ACTION_LABELS: Record<ActionType, string> = {
  EMAIL: 'Email',
  CALL: 'Call',
  LINKEDIN_CONNECT: 'LinkedIn connect',
  LINKEDIN_MESSAGE: 'LinkedIn message',
};

export type Channel = 'EMAIL' | 'CALL' | 'LINKEDIN';

export function channelOf(action: ActionType): Channel {
  if (action === 'EMAIL') return 'EMAIL';
  if (action === 'CALL') return 'CALL';
  return 'LINKEDIN';
}

/** Actions that can be completed by observing Twenty activity. LinkedIn is manual only. */
export function isObservable(action: ActionType): boolean {
  return action === 'EMAIL' || action === 'CALL';
}

/**
 * One module of a step: an email, a call or a LinkedIn touch, with the copy the FO starts from.
 *
 * The copy may carry a handful of tokens ({{firstName}}, {{company}}, ... see personalize.ts). They
 * are filled in for the person when the task is created, with a fallback where the record is
 * blank, so a half-substituted "Hi ," never reaches a prospect and a task never shows a token.
 */
export const StepActionSchema = z.object({
  /** Stable id, kept across edits so a live enrollment stays matched to its module. */
  id: z.string().min(1),
  type: ActionTypeSchema,
  label: z.string().min(1),
  /** Email subject (email modules only). */
  subject: z.string().optional(),
  /** Plain-text fallback of the body, kept in step with bodyHtml. */
  template: z.string().optional(),
  /** The body as rich text, which is what the editor and the task composer work with. */
  bodyHtml: z.string().max(100000).optional(),
});

export const SequenceStepSchema = z.object({
  id: z.string().min(1),
  /** Working-day offset from the enrollment start. Day 1 = the start date. */
  day: z.number().int().min(1),
  title: z.string().optional(),
  /** One or more modules. A call and its follow-up email belong to one step, not two. */
  actions: z.array(StepActionSchema).min(1),
});

export const StepsSchema = z
  .array(SequenceStepSchema)
  .min(1)
  .superRefine((steps, ctx) => {
    const ids = new Set<string>();
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (ids.has(step.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate step id ${step.id}`, path: [i, 'id'] });
      }
      ids.add(step.id);
      if (i > 0 && step.day <= steps[i - 1].day) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Step ${i + 1} (day ${step.day}) must be later than step ${i} (day ${steps[i - 1].day})`,
          path: [i, 'day'],
        });
      }
      const actionIds = new Set<string>();
      for (let j = 0; j < step.actions.length; j++) {
        const a = step.actions[j];
        if (actionIds.has(a.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate action id ${a.id}`, path: [i, 'actions', j, 'id'] });
        }
        actionIds.add(a.id);
      }
    }
  });

export type StepAction = z.infer<typeof StepActionSchema>;
export type SequenceStep = z.infer<typeof SequenceStepSchema>;

export function parseSteps(json: unknown): SequenceStep[] {
  return StepsSchema.parse(json);
}

export function safeParseSteps(json: unknown): { ok: true; steps: SequenceStep[] } | { ok: false; error: string } {
  const r = StepsSchema.safeParse(json);
  if (r.success) return { ok: true, steps: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

let counter = 0;
export function newStepId(prefix: 'step' | 'act' = 'step'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function describeAction(a: Pick<StepAction, 'label'>): string {
  return a.label;
}

export function describeStep(step: SequenceStep): string {
  return step.actions.map(describeAction).join(', then ');
}

export function lastDay(steps: SequenceStep[]): number {
  return steps.length ? steps[steps.length - 1].day : 0;
}
