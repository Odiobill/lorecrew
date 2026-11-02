import { AppError } from '../contracts/base.js';
import type { ProjectRegistration } from './types.js';

/** Explicit fork identities also cover local repositories and unrecognized hosts. */
export function canonicalRepositoryKey(value: string): string {
  const invalid = () => new AppError('AMBIGUOUS_REPOSITORY', 'Use a recognized HTTPS/SSH repository URL or an explicit fork:IDENTITY key');
  if (typeof value !== 'string' || value !== value.trim() || /[\s\\?#%]/.test(value)) throw invalid();
  if (/^fork:[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.split('/').some(part => part === '.' || part === '..')) return value;
  let host: string; let path: string;
  const canonical = /^repo:([^/]+)\/(.+)$/.exec(value);
  const scp = /^git@([^/:]+):(.+)$/.exec(value);
  if (canonical) { host = canonical[1]!; path = canonical[2]!; }
  else if (scp) { host = scp[1]!; path = scp[2]!; }
  else {
    // Check raw segments before URL parsing can collapse dot segments.
    if (value.split('/').some(part => part === '.' || part === '..')) throw invalid();
    let url: URL; try { url = new URL(value); } catch { throw invalid(); }
    if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.port || (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))) throw invalid();
    host = url.hostname; path = url.pathname.replace(/^\//, '');
  }
  host = host.toLowerCase(); path = path.replace(/\/$/, '').replace(/\.git$/, '');
  if (!['github.com', 'gitlab.com', 'bitbucket.org'].includes(host) || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(path) || path.split('/').some(part => part === '.' || part === '..')) throw invalid();
  if ((host === 'github.com' || host === 'bitbucket.org') && path.split('/').length !== 2) throw invalid();
  if (host === 'gitlab.com' && path.split('/').includes('-')) throw invalid();
  // GitHub and Bitbucket repository paths are case-insensitive; GitLab groups may be nested.
  if (host === 'github.com' || host === 'bitbucket.org') path = path.toLowerCase();
  return `repo:${host}/${path}`;
}
export function registerProject(projects: ProjectRegistration[], input: ProjectRegistration): ProjectRegistration {
  if (!input || typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.id) || typeof input.title !== 'string' || !input.title.trim()) throw new AppError('INVALID_PROJECT', 'Project ID and title are required');
  const project = { id: input.id, title: input.title, repositoryKey: canonicalRepositoryKey(input.repositoryKey) };
  const previous = projects.find(item => item.id === project.id);
  if (previous && previous.repositoryKey !== project.repositoryKey) throw new AppError('PROJECT_CONFLICT', 'Project ID is registered to a different repository');
  if (projects.some(item => item.repositoryKey === project.repositoryKey && item.id !== project.id)) throw new AppError('REPOSITORY_REGISTERED', 'Repository already has a project');
  if (!previous) projects.push(project);
  return previous ?? project;
}
