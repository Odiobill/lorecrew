// Mail engine v4 accepts a single options object.
export function compile({ source, bindings }) { return source.replace('{{customer}}', bindings.customer); }
