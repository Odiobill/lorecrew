import { createHash } from 'node:crypto';
import { AppError } from '../contracts/base.js';
import type { Assignment, Ownership, QuiescenceProbe } from './types.js';

/**
 * A stable request resumes its durable transition; failures never reopen admission.
 * The probe must join both Pi-owned work and supervised processes. Runtime.stopAndProve
 * supplies that combined proof; process-only probes are insufficient once sessions exist.
 */
export async function handoffProject(input: {
  ownership: Ownership; probe: QuiescenceProbe; projectId: string;
  expectedGeneration: number; targetInstanceId: string; requestId: string;
}): Promise<Assignment> {
  if (typeof input.requestId !== 'string' || !input.requestId.trim()) throw new AppError('INVALID_REQUEST', 'A stable handoff request ID is required');
  const request = {
    projectId: input.projectId, expectedGeneration: input.expectedGeneration, targetInstanceId: input.targetInstanceId,
    transitionId: createHash('sha256').update(JSON.stringify([input.projectId, input.expectedGeneration, input.targetInstanceId, input.requestId])).digest('hex'),
  };
  const pending = await input.ownership.closeAdmission(request);
  if (!pending.quiescenceProven) await input.ownership.proveQuiescence(request, input.probe);
  if (pending.phase === 'closed') await input.ownership.revokeLocal(input.projectId, input.expectedGeneration);
  return input.ownership.publishTransfer(request);
}
