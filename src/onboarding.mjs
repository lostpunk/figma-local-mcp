import { z } from 'zod';
import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { projectConfigSchema, loadProjectRules } from './project-config.mjs';
import { distributionSchema, loadDistribution } from './distribution.mjs';

const label = z.string().trim().min(1).max(200);
export const answersSchema = z.object({
  designSystem: z.enum(['existing', 'shadcn-ui', 'material', 'custom', 'later', 'distribution']),
  name: label.optional(), libraryName: label.optional(),
  theme: z.enum(['existing', 'light', 'dark']).optional(),
  density: z.enum(['existing', 'comfortable', 'compact']).optional(),
  platform: z.enum(['existing', 'web', 'mobile', 'both']).optional(),
  fontFamily: label.optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  rules: z.array(z.string().trim().min(1).max(2000)).max(30).optional(),
}).strict().superRefine((value, context) => {
  if (value.designSystem === 'custom' && !value.libraryName) context.addIssue({ code: 'custom', path: ['libraryName'], message: 'Name your design system' });
});

export const questions = [
  { id: 'designSystem', title: 'Какую дизайн-систему использовать в этом проекте?', options: [
    { value: 'existing', label: 'Сохранить стиль открытого файла Figma' },
    { value: 'shadcn-ui', label: 'shadcn/ui — ориентир для новых компонентов' },
    { value: 'material', label: 'Material Design — ориентир для новых компонентов' },
    { value: 'custom', label: 'Своя дизайн-система' },
    { value: 'later', label: 'Решить позже' },
  ] },
  { id: 'theme', title: 'Тема', options: ['existing', 'light', 'dark'] },
  { id: 'density', title: 'Плотность интерфейса', options: ['existing', 'comfortable', 'compact'] },
  { id: 'platform', title: 'Устройства', options: ['existing', 'web', 'mobile', 'both'] },
  { id: 'fontFamily', title: 'Шрифт; можно оставить как в макете' },
  { id: 'primaryColor', title: 'Цвет бренда #RRGGBB; можно оставить как в макете' },
  { id: 'rules', title: 'Дополнительные правила проекта' },
];

export function configFromAnswers(raw, projectName, distribution = null) {
  const answers = answersSchema.parse(raw);
  if (answers.designSystem === 'distribution') {
    if (!distribution) throw new Error('This package has no distribution design system');
    const policy = distributionSchema.parse(distribution);
    const config = configFromAnswers({ ...answers, designSystem: 'custom', libraryName: policy.defaults.library.name }, projectName);
    return projectConfigSchema.parse({ ...config, ...policy.defaults, rules: [...policy.defaults.rules, ...(answers.rules ?? [])] });
  }
  if (answers.designSystem === 'later') return projectConfigSchema.parse({ onboarding: { status: 'deferred', designSystem: 'later' } });
  const config = { schemaVersion: 1, onboarding: { status: 'configured', designSystem: answers.designSystem },
    profile: answers.designSystem === 'shadcn-ui' ? 'shadcn-ui' : 'custom',
    foundation: { name: answers.name ?? projectName }, rules: answers.rules ?? [],
  };
  if (answers.designSystem === 'existing') {
    config.rules = ['Сначала изучить и переиспользовать стили, переменные и компоненты открытого файла Figma; не заменять их стартовой дизайн-системой.', ...config.rules];
  } else {
    config.library = { name: answers.designSystem === 'shadcn-ui' ? 'shadcn/ui' : answers.designSystem === 'material' ? 'Material Design' : answers.libraryName,
      mode: 'reference', components: {} };
  }
  if (answers.theme && answers.theme !== 'existing') config.foundation.theme = answers.theme;
  if (answers.density && answers.density !== 'existing') config.density = answers.density;
  if (answers.fontFamily) config.foundation.fontFamily = answers.fontFamily;
  if (answers.primaryColor) config.foundation.colors = [{ name: 'brand/primary', value: answers.primaryColor }];
  if (answers.platform && answers.platform !== 'existing') config.viewports = {
    ...(answers.platform !== 'mobile' ? { desktop: 1440 } : {}),
    ...(answers.platform !== 'web' ? { mobile: 390 } : {}),
  };
  return projectConfigSchema.parse(config);
}

export function projectQuestions(distribution = null) {
  if (!distribution) return questions;
  return [{ ...questions[0], defaultValue: 'distribution', options: [
    { value: 'distribution', label: `${distribution.label} — по умолчанию` }, ...questions[0].options,
  ] }, ...questions.slice(1)];
}

export async function collectAnswers(ask, projectName, distribution = null) {
  const choose = async (prompt, options, defaultValue) => {
    while (true) {
      const response = (await ask(`${prompt}\n${options.map(([value, text], i) => `${i + 1}. ${text}`).join('\n')}\nВыбор${defaultValue ? ` [${defaultValue}]` : ''}: `)).trim();
      const value = response || defaultValue;
      const choice = options.find(([key], i) => key === value || String(i + 1) === value);
      if (choice) return choice[0];
    }
  };
  const first = projectQuestions(distribution)[0];
  const designSystem = await choose(first.title, first.options.map(o => [o.value, o.label]), first.defaultValue);
  if (designSystem === 'later') return { designSystem };
  const answers = { designSystem };
  answers.name = (await ask(`Название проекта [${projectName}]: `)).trim() || projectName;
  if (designSystem === 'custom') {
    do { answers.libraryName = (await ask('Название своей дизайн-системы: ')).trim(); } while (!answers.libraryName);
  }
  answers.theme = await choose('Тема', [['existing', 'Оставить текущую / решить по макету'], ['light', 'Светлая'], ['dark', 'Тёмная']], 'existing');
  answers.density = await choose('Плотность', [['existing', 'Оставить текущую'], ['comfortable', 'Просторная'], ['compact', 'Компактная']], 'existing');
  answers.platform = await choose('Устройства', [['existing', 'Определить по задаче'], ['web', 'Веб'], ['mobile', 'Мобильные'], ['both', 'Веб и мобильные']], 'existing');
  const font = (await ask('Шрифт [Enter — сохранить текущий]: ')).trim();
  if (font) answers.fontFamily = font;
  while (true) {
    const color = (await ask('Цвет бренда #RRGGBB [Enter — сохранить текущий]: ')).trim();
    if (!color) break;
    if (/^#[0-9a-fA-F]{6}$/.test(color)) { answers.primaryColor = color; break; }
  }
  const rule = (await ask('Дополнительное правило [Enter — пропустить]: ')).trim();
  if (rule) answers.rules = [rule];
  return answersSchema.parse(answers);
}

export async function onboardProject(options = {}) {
  const distribution = options.distribution === undefined ? await loadDistribution() :
    options.distribution === null ? null : distributionSchema.parse(options.distribution);
  const result = await runOnboarding({ ...options, distribution });
  return distribution ? { ...result, welcome: distribution.welcome, distributionDefault: distribution.label } : result;
}

async function runOnboarding({ projectRoot, answers, answersFile, interactive = false, ask, distribution }) {
  if (interactive && !ask) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    terminal.on('close', () => controller.abort());
    terminal.on('SIGINT', () => { controller.abort(); terminal.close(); });
    if (distribution) process.stdout.write(`${distribution.welcome}\n\n`);
    try { return await runOnboarding({ projectRoot, answers, answersFile, interactive, distribution,
      ask: prompt => terminal.question(prompt, { signal: controller.signal }) }); }
    finally { terminal.close(); }
  }
  if (!projectRoot && interactive) {
    projectRoot = (await ask('Папка проекта для правил дизайна [Enter — настроить позже]: ')).trim();
    if (!projectRoot) return { status: 'deferred', path: null, message: 'Настройка проекта отложена. Глобальные правила не созданы.' };
  }
  if (!projectRoot) return { status: 'needs_project', message: 'Выберите папку проекта для персональных правил дизайна. Глобальная дизайн-система не задаётся.' };
  const root = await realpath(projectRoot);
  if (!(await stat(root)).isDirectory()) throw new Error('Select a project directory');
  const path = join(root, '.figma-design.json');
  // Existing choices, even a deferred choice, take precedence over installer defaults/answers.
  let present = false;
  try { await lstat(path); present = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (present) {
    await loadProjectRules(root);
    return { status: 'existing', path, message: 'Правила проекта сохранены без изменений.' };
  }
  if (answers && answersFile) throw new Error('Choose answers or answersFile');
  if (answersFile) {
    const info = await stat(answersFile);
    if (!info.isFile() || info.size > 16384) throw new Error('Answers must be a JSON file of at most 16 KiB');
    answers = JSON.parse(await readFile(answersFile, 'utf8'));
  }
  if (!answers && interactive) {
    answers = await collectAnswers(ask, basename(root), distribution);
  }
  if (!answers) return { status: 'needs_input', project: root, questions: projectQuestions(distribution),
    message: 'Спросите пользователя в чате и передайте его ответы через --answers FILE. Настройки не выбраны автоматически.' };
  const config = configFromAnswers(answers, basename(root), distribution);
  try { await writeFile(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o644 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await loadProjectRules(root);
    return { status: 'existing', path, message: 'Правила уже созданы другим запуском и сохранены.' };
  }
  return { status: config.onboarding.status, path, config,
    message: 'Выбор сохранён только для этого проекта. Файл Figma не изменён. Выбор библиотеки не устанавливает сторонний Figma-кит.' };
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('node onboarding.mjs --project PATH [--answers JSON_FILE | --non-interactive]\nFirst-time project choices; existing configuration is never overwritten.'); return;
  }
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--non-interactive') options.nonInteractive = true;
    else if (['--project', '--answers'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[argv[i].slice(2)] = argv[++i];
    else throw new Error(`Unknown option or missing value: ${argv[i]}`);
  }
  console.log(JSON.stringify(await onboardProject({ projectRoot: options.project, answersFile: options.answers,
    interactive: !options.nonInteractive && !!process.stdin.isTTY && !!process.stdout.isTTY }), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
