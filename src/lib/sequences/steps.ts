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

const AlternativeSchema = z.object({
  type: ActionTypeSchema,
  label: z.string().min(1),
  subject: z.string().optional(),
  template: z.string().optional(),
});

/** An A/B template variant. Balanced random assignment at task generation; disable to retire it. */
export const VariantSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  subject: z.string().optional(),
  template: z.string().optional(),
  enabled: z.boolean().default(true),
});
export type TemplateVariant = z.infer<typeof VariantSchema>;

export const StepActionSchema = z.object({
  /** Stable id, preserved across versions so enrollments can be mapped between versions. */
  id: z.string().min(1),
  type: ActionTypeSchema,
  label: z.string().min(1),
  /** Email subject (email actions only). */
  subject: z.string().optional(),
  /** Email body, call script or LinkedIn message with {{variables}}. */
  template: z.string().optional(),
  /** Either/or: the FO may do this instead of `type`. */
  alternative: AlternativeSchema.optional(),
  /** A/B test: when present with at least one enabled variant, each task gets one variant. */
  variants: z.array(VariantSchema).optional(),
  /** Hint for the FO: send this as a reply in the existing email thread. */
  replyInThread: z.boolean().optional(),
});

export const SequenceStepSchema = z.object({
  id: z.string().min(1),
  /** Day offset from enrollment start. Day 1 = the start date. */
  day: z.number().int().min(1),
  title: z.string().optional(),
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
        if (a.alternative && a.alternative.type === a.type) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Either/or alternative must be a different action type',
            path: [i, 'actions', j, 'alternative'],
          });
        }
        if (a.variants) {
          const vids = new Set<string>();
          for (const v of a.variants) {
            if (vids.has(v.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate variant id ${v.id}`, path: [i, 'actions', j, 'variants'] });
            vids.add(v.id);
          }
          if (a.variants.length && !a.variants.some((v) => v.enabled !== false)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one A/B variant must stay enabled (or remove the variants)', path: [i, 'actions', j, 'variants'] });
          }
        }
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

export function describeAction(a: Pick<StepAction, 'label' | 'alternative'>): string {
  return a.alternative ? `${a.label} or ${a.alternative.label}` : a.label;
}

export function describeStep(step: SequenceStep): string {
  return step.actions.map(describeAction).join(', then ');
}

export function lastDay(steps: SequenceStep[]): number {
  return steps.length ? steps[steps.length - 1].day : 0;
}

export function enabledVariants(action: Pick<StepAction, 'variants'>): TemplateVariant[] {
  return (action.variants ?? []).filter((v) => v.enabled !== false);
}

/**
 * Balanced random assignment (Outreach style): pick among the enabled variants with the fewest
 * assignments so far; ties broken at random.
 */
export function pickVariant(action: Pick<StepAction, 'variants'>, counts: Map<string, number>, random: () => number = Math.random): TemplateVariant | null {
  const enabled = enabledVariants(action);
  if (!enabled.length) return null;
  const min = Math.min(...enabled.map((v) => counts.get(v.id) ?? 0));
  const pool = enabled.filter((v) => (counts.get(v.id) ?? 0) === min);
  return pool[Math.floor(random() * pool.length)] ?? pool[0];
}

/** The subject/template the FO should use: the assigned variant if any, else the action's own copy. */
export function resolveCopy(action: Pick<StepAction, 'subject' | 'template' | 'variants' | 'label'>, variantId: string | null | undefined): { subject?: string; template?: string; variantLabel: string | null } {
  const v = variantId ? action.variants?.find((x) => x.id === variantId) : undefined;
  if (v) return { subject: v.subject ?? action.subject, template: v.template ?? action.template, variantLabel: v.label };
  return { subject: action.subject, template: action.template, variantLabel: null };
}
