import fs from 'node:fs';
import path from 'node:path';

// Only literal arguments are inspected. Guest JavaScript is never evaluated.
function tokens(source) {
  const result = [];
  let index = 0;
  function quoted(quote) {
    const start = index++;
    let value = '', literal = true;
    while (index < source.length) {
      const character = source[index++];
      if (character === quote) return { kind: literal ? 'string' : 'opaque', value, start };
      if (quote === '`' && character === '$' && source[index] === '{') {
        literal = false;
        index++;
        let depth = 1;
        while (index < source.length && depth) {
          const next = source[index];
          if (next === '"' || next === "'" || next === '`') quoted(next);
          else if (source.startsWith('//', index)) {
            while (index < source.length && !/[\r\n\u2028\u2029]/.test(source[index])) index++;
          } else if (source.startsWith('/*', index)) {
            const end = source.indexOf('*/', index + 2);
            index = end < 0 ? source.length : end + 2;
          } else { index++; if (next === '{') depth++; if (next === '}') depth--; }
        }
      } else if (character === '\\') {
        const escaped = source[index++];
        if (escaped === '\n') continue;
        if (escaped === '\r') { if (source[index] === '\n') index++; continue; }
        const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
        if (escaped === 'x' || escaped === 'u') {
          const braced = escaped === 'u' && source[index] === '{';
          const end = braced ? source.indexOf('}', index + 1) : index + (escaped === 'x' ? 2 : 4);
          const hex = source.slice(index + (braced ? 1 : 0), end);
          const code = /^[0-9a-f]+$/i.test(hex) ? parseInt(hex, 16) : NaN;
          if (end < index || !Number.isFinite(code) || code > 0x10ffff) literal = false;
          else value += String.fromCodePoint(code);
          index = end < index ? source.length : end + (braced ? 1 : 0);
        } else if (/[1-9]/.test(escaped || '') || (escaped === '0' && /\d/.test(source[index] || ''))) literal = false;
        else value += simple[escaped] ?? escaped ?? '';
      } else value += character;
    }
    return { kind: 'opaque', start };
  }
  const parentheses = [];
  while (index < source.length) {
    const start = index, character = source[index], previous = result.at(-1);
    if (/\s/.test(character)) { index++; continue; }
    if (source.startsWith('//', index)) {
      while (index < source.length && !/[\r\n\u2028\u2029]/.test(source[index])) index++;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { result.push(quoted(character)); continue; }
    if (character === '/' && (!previous || previous.control ||
        (previous.kind === 'punctuation' && ![')', ']', '++', '--', '.', '?.'].includes(previous.value)) ||
        /^(?:return|throw|case|yield|await|delete|void|typeof|in|instanceof|else|do)$/.test(previous.value))) {
      index++;
      let inClass = false;
      while (index < source.length) {
        const next = source[index++];
        if (next === '\\') index++;
        else if (next === '[') inClass = true;
        else if (next === ']') inClass = false;
        else if (next === '/' && !inClass) break;
      }
      while (/[a-z]/i.test(source[index] || '')) index++;
      result.push({ kind: 'opaque', start });
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(index));
    if (word) { result.push({ kind: 'word', value: word[0], start }); index += word[0].length; continue; }
    const punctuation = /^(?:=>|\?\.|===|!==|==|!=|\+\+|--|\+=|-=|&&|\|\|)/.exec(source.slice(index));
    const value = punctuation ? punctuation[0] : character;
    if (value === '(') parentheses.push(/^(?:if|while|for|with|switch|catch)$/.test(previous?.value));
    const control = value === ')' && parentheses.pop();
    result.push({ kind: 'punctuation', value, start, control });
    index += value.length;
  }
  return result;
}

function member(list, start) {
  if (list[start]?.kind !== 'word') return null;
  const parts = [list[start].value];
  let end = start + 1;
  while (list[end]?.value === '.' || list[end]?.value === '?.' || list[end]?.value === '[') {
    if (list[end].value === '[') {
      if (list[end + 1]?.kind !== 'string' || list[end + 2]?.value !== ']') break;
      parts.push(list[end + 1].value); end += 3;
    } else {
      if (list[end + 1]?.kind !== 'word') break;
      parts.push(list[end + 1].value); end += 2;
    }
  }
  return { name: parts.join('.'), end };
}

function firstArgument(list, opening) {
  let end = opening + 1, depth = 0;
  for (; end < list.length; end++) {
    const value = list[end].value;
    if (!depth && (value === ',' || value === ')')) break;
    if (['(', '[', '{'].includes(value)) depth++;
    if ([')', ']', '}'].includes(value)) depth--;
  }
  return list.slice(opening + 1, end);
}

function scriptCalls(source) {
  const list = tokens(source), calls = [], functions = [];
  let depth = 0;
  for (let index = 0; index < list.length; index++) {
    const token = list[index];
    if (token.value === '{') depth++;
    if (token.value === '}') depth--;
    if (token.value === 'function' && depth === 0 && list[index + 1]?.kind === 'word' && list[index + 2]?.value === '(') {
      const name = list[index + 1].value, parameter = list[index + 3];
      let body = index + 3;
      while (body < list.length && list[body].value !== '{') body++;
      let end = body + 1, nesting = 1;
      while (end < list.length && nesting) {
        if (list[end].value === '{') nesting++;
        if (list[end].value === '}') nesting--;
        end++;
      }
      const contents = list.slice(body + 1, end - 1);
      if (parameter?.kind === 'word' && !contents.some((item, i) =>
        item.value === 'function' || item.value === '=>' ||
        (item.value === parameter.value && ['=', '+=', '-=', '++', '--'].includes(contents[i + 1]?.value)))) {
        functions.push({ name, parameter: parameter.value, start: list[body]?.start, end: list[end - 1]?.start });
      }
    }
    if (token.kind !== 'word' || ['.', '?.', 'function'].includes(list[index - 1]?.value)) continue;
    const callee = member(list, index);
    if (list[callee.end]?.value !== '(') continue;
    calls.push({ name: callee.name, argument: firstArgument(list, callee.end), start: token.start });
  }
  return { calls, functions };
}

const steamMethods = /^(?:activateAchievement|clearAchievement|getAchievement|indicateAchievementProgress)$/;
function isSteamCall(name, families) {
  const parts = name.split('.'), method = parts.pop(), receiver = parts.pop();
  if (steamMethods.test(method) && /^(?:greenworks|steamworks)$/i.test(receiver)) return true;
  if (steamMethods.test(method) && receiver === 'OrangeGreenworks' && families.has('orange')) return true;
  if (steamMethods.test(method) && receiver === 'CycloneSteam' && families.has('cyclone')) return true;
  if (['unlockAchievement', 'clearAchievement', 'getAchievement'].includes(method) &&
      receiver === '$gameSystem' && families.has('archeia')) return true;
  return /\.achievement\.(?:activate|clear|isActivated)$/.test(name) && families.has('steamworks');
}

export function achievementFiles(gameDir, plugins) {
  const files = plugins.filter(plugin => plugin.status).map(plugin => 'js/plugins/' + plugin.name + '.js');
  const integration = plugins.some(plugin => plugin.status && /(?:Archeia_Steamworks|OrangeGreenworks|Cyclone-Steam|VisuMZ_5_Steamworks)$/.test(plugin.name)) ||
    files.some(file => fs.existsSync(path.join(gameDir, file)) &&
      /greenworks|steamworks/i.test(fs.readFileSync(path.join(gameDir, file), 'utf8')));
  const data = path.join(gameDir, 'data');
  if (integration && fs.existsSync(data)) files.push(...fs.readdirSync(data).filter(name =>
    /^(?:Map\d+|CommonEvents|Troops|Items|Weapons|Armors|Classes)\.json$/i.test(name)).sort().map(name => 'data/' + name));
  return [...new Set(files)].sort();
}

export function discoverAchievements(gameDir, plugins) {
  const active = plugins.filter(plugin => plugin.status), families = new Set();
  for (const plugin of active) {
    if (/(?:^|\/)Archeia_Steamworks$/i.test(plugin.name)) families.add('archeia');
    if (/(?:^|\/)OrangeGreenworks$/i.test(plugin.name)) families.add('orange');
    if (/(?:^|\/)Cyclone-Steam$/i.test(plugin.name)) families.add('cyclone');
    if (/(?:^|\/)VisuMZ_5_Steamworks$/i.test(plugin.name)) families.add('visumz');
  }
  const references = [], diagnostics = [], scripts = [], wrappers = new Set(), ids = new Set();
  const add = (id, file, kind) => {
    if (typeof id !== 'string' || !id || /\\[vV]\[/.test(id)) { diagnostics.push({ file, reason: 'dynamic-achievement-id', kind }); return; }
    ids.add(id); references.push({ id, file, kind });
  };
  for (const plugin of active) {
    const file = 'js/plugins/' + plugin.name + '.js';
    const full = path.join(gameDir, file);
    if (!fs.existsSync(full)) { diagnostics.push({ file, reason: 'missing-enabled-plugin' }); continue; }
    const source = fs.readFileSync(full, 'utf8');
    if (!/achiev|greenworks|steamworks/i.test(source)) continue;
    const parsed = scriptCalls(source);
    if (parsed.calls.some(call => call.name === 'require' && call.argument.length === 1 &&
        call.argument[0].kind === 'string' && /greenworks|steamworks/i.test(call.argument[0].value))) families.add('steamworks');
    scripts.push({ file, ...parsed });
  }
  for (const script of scripts) {
    for (const definition of script.functions) {
      if (script.calls.some(call => call.start > definition.start && call.start < definition.end &&
          isSteamCall(call.name, families) && call.argument.length === 1 &&
          call.argument[0].kind === 'word' && call.argument[0].value === definition.parameter)) wrappers.add(definition.name);
    }
  }
  function scan(script, event = false) {
    for (const call of script.calls) {
      if (!families.size || !(isSteamCall(call.name, families) || wrappers.has(call.name))) continue;
      if (call.argument.length === 1 && call.argument[0].kind === 'string') add(call.argument[0].value, script.file, event ? 'event-script' : 'plugin-script');
      else if (event) diagnostics.push({ file: script.file, reason: 'dynamic-achievement-id', callee: call.name });
    }
  }
  scripts.forEach(script => scan(script));
  function commands(list, file) {
    for (let index = 0; index < list.length; index++) {
      const command = list[index];
      if (!command || !Array.isArray(command.parameters)) continue;
      const p = command.parameters, location = file + '/command=' + index;
      let source;
      if (command.code === 355) {
        source = p[0];
        while (list[index + 1]?.code === 655) source += '\n' + list[++index].parameters[0];
      } else if (command.code === 111 && p[0] === 12) source = p[1];
      else if (command.code === 122 && p[3] === 4) source = p[4];
      else if (command.code === 45) source = p[0];
      if (typeof source === 'string') scan({ file: location, ...scriptCalls(source) }, true);
      if (command.code === 356 && families.has('archeia') && typeof p[0] === 'string') {
        const parts = p[0].split(' ');
        if (parts[0].toLowerCase() === 'steamworks' && /^(?:activateachievement|giveachivement|grantachievement|deactivateachievement|clearachievement)$/.test(parts[1]?.toLowerCase())) add(parts.slice(2).join(''), location, 'mv-plugin-command');
      }
      if (command.code === 357 && /achievement/i.test(String(p[1]))) {
        const enabled = active.some(plugin => plugin.name === p[0]);
        if (!enabled) { diagnostics.push({ file: location, reason: 'inactive-plugin-command', plugin: p[0] }); continue; }
        if (/(?:^|\/)VisuMZ_5_Steamworks$/i.test(p[0]) &&
            /^(?:ActivateAchievement|ClearAchievement|IsAchievementUnlocked|IndicateAchievement)$/.test(p[1])) add(p[3]?.['Name:str'], location, 'mz-plugin-command');
        else diagnostics.push({ file: location, reason: 'unsupported-plugin-command', plugin: p[0], command: p[1] });
      }
      if (command.code === 205 && Array.isArray(p[1]?.list)) commands(p[1].list, location + '/move-route');
    }
  }
  const inputs = achievementFiles(gameDir, plugins);
  if (!families.size) return { catalog: [], families: [], references, diagnostics,
    inputs, coverage: 'no-enabled-provider' };
  for (const file of inputs.filter(file => file.startsWith('data/'))) {
    const source = fs.readFileSync(path.join(gameDir, file), 'utf8');
    if (!/achiev|troph|steamworks|greenworks|unlockAchievement/i.test(source)) continue;
    let data;
    try { data = JSON.parse(source); }
    catch (error) { diagnostics.push({ file, reason: 'invalid-data', message: error.message }); continue; }
    const records = Array.isArray(data) ? data : data.events || [];
    for (const record of records) {
      if (!record) continue;
      const location = file + '#record=' + record.id;
      if (Array.isArray(record.list)) commands(record.list, location);
      for (const [index, page] of (record.pages || []).entries()) commands(page.list || [], location + '/page=' + index);
      if (families.has('archeia') && typeof record.note === 'string' &&
          /\/(?:Items|Weapons|Armors|Classes)\.json$/i.test(file)) {
        const suffix = /\/Classes\.json$/i.test(file) ? '(?:LEARN|UNLEARN),\\d+' : '[+-]\\d+';
        const pattern = new RegExp('<(?:achievement grant|achievement unlocked|achieved|achievement clear|achievement taken|unachieved): (.*),(' + suffix + ')/>', 'gi');
        for (const match of record.note.matchAll(pattern)) add(match[1], location, 'database-notetag');
      }
    }
  }
  return { catalog: [...ids].sort().map(id => ({ id })), families: [...families].sort(),
    references, diagnostics, inputs, coverage: 'referenced-ids' };
}
