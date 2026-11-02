import { compile } from './engine.mjs';
export const receipt = customer => compile('Thanks {{customer}}', { customer });
