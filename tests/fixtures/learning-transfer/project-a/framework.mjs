// Local framework v2: the dependency removed the positional callback API.
export const version = '2.0.0';
export function render({ template, values }) { return template.replace('{name}', values.name); }
