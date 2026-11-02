import { render } from './framework.mjs';
export const greeting = name => render('Hello {name}', { name });
