export const ASSIGNMENT_BRANCH = 'lorecrew/assignments';
export const ASSIGNMENT_REF = `refs/heads/${ASSIGNMENT_BRANCH}`;
export const FETCHED_ASSIGNMENT_REF = 'refs/lorecrew/fetched-assignments';
export const SHARED_REF = 'refs/heads/main';
export const FETCHED_SHARED_REF = 'refs/lorecrew/shared';
export const CONTRIBUTION_PREFIX = 'refs/heads/lorecrew/contributions/';
export const FETCHED_CONTRIBUTION_PREFIX = 'refs/lorecrew/contributions/';
export function contributionRef(instanceId:string):string {
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(instanceId))throw new Error('Invalid contribution instance ID');
  return `${CONTRIBUTION_PREFIX}${instanceId}`;
}
