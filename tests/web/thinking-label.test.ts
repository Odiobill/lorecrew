import {expect,it} from 'vitest';
import {thinkingLabel} from '../../web/features/thinking-label.js';
it.each(['__proto__','constructor','toString','hasOwnProperty','alien'])('historical_thinking_label_remains_text_%s',level=>{expect(thinkingLabel({kind:'explicit',level})).toBe(level);});
it('readable_labels_preserve_default_and_explicit_off',()=>{expect(thinkingLabel()).toBe('Default');expect(thinkingLabel({kind:'default'})).toBe('Default');expect(thinkingLabel({kind:'explicit',level:'off'})).toBe('Off');expect(thinkingLabel({kind:'explicit',level:'high'})).toBe('High');});
