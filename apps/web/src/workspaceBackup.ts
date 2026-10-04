import { z } from 'zod';
import { assertProjectByteLength, parseProject, serializeProject, type Project } from './project';
import { validateWorkspaceDraft, type WorkspaceDraft } from './projectRepository';

const backupSchema = z.object({ format: z.literal('ugoku-kami-recovery'), version: z.literal(1), project: z.unknown(), draft: z.unknown() }).strict();
const withinLimit = (text: string) => assertProjectByteLength(new TextEncoder().encode(text).byteLength);

/** Portable recovery explicitly separates unfinished input from the validated design. */
export async function serializeWorkspaceBackup(project: Project, draft: WorkspaceDraft): Promise<string> {
  const payload = JSON.parse(serializeProject(project)) as unknown;
  const safeDraft = await validateWorkspaceDraft(draft);
  if (safeDraft.recordDraft?.designId && safeDraft.recordDraft.designId !== project.document.designId) throw new Error('実物記録の下書きは元の作品から書き出してください。');
  const text = JSON.stringify({ format: 'ugoku-kami-recovery', version: 1, project: payload, draft: safeDraft });
  withinLimit(text);
  return text;
}

export async function parseWorkspaceFile(text: string): Promise<{project: Project; draft?: WorkspaceDraft}> {
  withinLimit(text);
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || !('format' in value) || value.format !== 'ugoku-kami-recovery') return { project: await parseProject(text) };
  const backup = backupSchema.parse(value);
  const project = await parseProject(JSON.stringify(backup.project));
  const draft = await validateWorkspaceDraft(backup.draft);
  if (draft.recordDraft?.designId && draft.recordDraft.designId !== project.document.designId) throw new Error('復元用の下書きが別の作品のものです。');
  return { project, draft };
}
