#!/usr/bin/env node
// Maintenance status for Chevron: overdue issue responses, release cadence, dated deadlines,
// open Dependabot PRs and install counts against the success markers.
//
// Config lives in .claude/maintenance.json. Dated deadlines live in the gitignored
// .claude/maintenance.local.json (`{"deadlines": [...]}`), on the maintainer's machine only. Output formats:
//   --format=hook      JSON for a Claude Code SessionStart hook (default)
//   --format=markdown  Markdown for the weekly GitHub workflow's status issue and for humans
//
// Every network call is optional and time-boxed. If GitHub or a registry is unreachable, that
// section says "unavailable" instead of failing, so a session never fails to start because of this.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;
const format = (process.argv.find((a) => a.startsWith('--format=')) ?? '--format=hook').slice(9);
const now = new Date(process.env.MAINTENANCE_NOW ?? Date.now());

const config = JSON.parse(await readFile(path.join(root, '.claude/maintenance.json'), 'utf8'));
const local = await readFile(path.join(root, '.claude/maintenance.local.json'), 'utf8').then(JSON.parse, () => ({}));
config.deadlines = [...(config.deadlines ?? []), ...(local.deadlines ?? [])];
const [owner, repo] = config.repo.split('/');
const days = (a, b) => Math.floor((b.getTime() - a.getTime()) / DAY);

async function githubToken() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
    return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  }
  try {
    return (await exec('gh', ['auth', 'token'], { timeout: 3000 })).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function releases() {
  try {
    const { stdout } = await exec(
      'git',
      ['tag', '--list', 'v*', '--sort=creatordate', '--format=%(refname:short) %(creatordate:iso-strict)'],
      { cwd: root, timeout: 3000 },
    );
    return stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [tag, date] = line.split(' ');
      return { tag, date: new Date(date) };
    });
  } catch {
    return [];
  }
}

async function issueStatus(token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'chevron-maintenance' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const items = await getJson(`${api}/issues?state=open&per_page=50`, { headers });
  const maintainers = new Set(config.maintainers.map((m) => m.toLowerCase()));
  const isMaintainer = (u) => maintainers.has((u?.login ?? '').toLowerCase());
  const overdue = [];
  const dependabot = [];
  for (const item of items) {
    if (item.pull_request) {
      if (item.user?.login === 'dependabot[bot]') {
        dependabot.push(item);
      }
      continue;
    }
    if (isMaintainer(item.user) || item.labels?.some((l) => l.name === 'maintenance-status')) {
      continue;
    }
    let answered = false;
    if (item.comments > 0) {
      const comments = await getJson(`${api}/issues/${item.number}/comments?per_page=100`, { headers });
      answered = comments.some((c) => isMaintainer(c.user));
    }
    const age = days(new Date(item.created_at), now);
    if (!answered && age >= config.issueResponseDays) {
      overdue.push({ number: item.number, title: item.title, age, url: item.html_url });
    } else if (!answered) {
      overdue.push({ number: item.number, title: item.title, age, url: item.html_url, dueIn: config.issueResponseDays - age });
    }
  }
  return { overdue, dependabot };
}

async function installs() {
  const result = {};
  const id = `${owner}.chevron`;
  try {
    const body = {
      filters: [{ criteria: [{ filterType: 7, value: id }] }],
      flags: 914,
    };
    const data = await getJson('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=7.2-preview.1' },
      body: JSON.stringify(body),
    });
    const ext = data.results?.[0]?.extensions?.[0];
    result.marketplace = ext ? (ext.statistics?.find((s) => s.statisticName === 'install')?.value ?? 0) : 'not published';
  } catch {
    result.marketplace = 'unavailable';
  }
  try {
    const data = await getJson(`https://open-vsx.org/api/${owner}/chevron`);
    result.openVsx = data.downloadCount ?? 0;
  } catch (err) {
    result.openVsx = String(err.message).startsWith('404') ? 'not published' : 'unavailable';
  }
  return result;
}

const lines = [];
const urgent = [];

// Releases and cadence
const tags = await releases();
const last = tags.at(-1);
if (!last) {
  lines.push('**Releases:** none yet.');
} else {
  const since = days(last.date, now);
  const due = config.releaseCadenceDays - since;
  lines.push(`**Releases:** last ${last.tag}, ${since} days ago (cadence: every ${config.releaseCadenceDays} days).`);
  if (due <= 0) {
    urgent.push(`Patch release overdue by ${-due} days. Even a dependency-bump release keeps the listing visibly alive.`);
  } else if (due <= config.warnWithinDays) {
    lines.push(`- Next patch release due in ${due} days.`);
  }
}

// Dated deadlines
for (const d of config.deadlines) {
  const left = days(now, new Date(`${d.date}T00:00:00Z`));
  if (left < -30) {
    continue;
  }
  const text = `${d.title} (${d.date}, ${left >= 0 ? `in ${left} days` : `${-left} days ago`}): ${d.action}`;
  if (left <= config.warnWithinDays) {
    urgent.push(text);
  } else {
    lines.push(`- Upcoming: ${text}`);
  }
}

// Issues and Dependabot
try {
  const { overdue, dependabot } = await issueStatus(await githubToken());
  const late = overdue.filter((o) => o.dueIn === undefined);
  const pending = overdue.filter((o) => o.dueIn !== undefined);
  lines.push(`**Issues awaiting a maintainer reply:** ${overdue.length} (response target: ${config.issueResponseDays} days).`);
  for (const o of late) {
    urgent.push(`Issue #${o.number} "${o.title}" has had no maintainer reply for ${o.age} days: ${o.url}`);
  }
  for (const o of pending) {
    lines.push(`- #${o.number} "${o.title}": reply due in ${o.dueIn} days.`);
  }
  if (dependabot.length) {
    lines.push(`**Dependabot PRs open:** ${dependabot.map((p) => `#${p.number}`).join(', ')}. Review and merge if CI is green.`);
  }
} catch (err) {
  lines.push(`**Issues:** unavailable (${err.message}). Set GITHUB_TOKEN or run \`gh auth login\` for issue tracking.`);
}

// Installs vs success markers
if (last) {
  const counts = await installs();
  const launch = tags[0].date;
  const age = days(launch, now);
  lines.push(`**Installs:** Marketplace ${counts.marketplace}, Open VSX downloads ${counts.openVsx} (Open VSX counts include auto-updates). Launched ${age} days ago.`);
  for (const m of config.successMarkers) {
    if (typeof counts.marketplace === 'number' && age <= m.daysAfterLaunch) {
      lines.push(`- Target: ${m.installs} installs by day ${m.daysAfterLaunch} (${m.label}): ${counts.marketplace >= m.installs ? 'reached ✅' : `${m.installs - counts.marketplace} to go`}.`);
    }
  }
}

const heading = urgent.length ? `⚠️ ${urgent.length} maintenance item(s) need attention` : '✅ Nothing overdue';
const markdown = [
  `## Chevron maintenance status: ${heading}`,
  `_Generated ${now.toISOString().slice(0, 10)} by scripts/maintenance-status.mjs_`,
  '',
  ...(urgent.length ? ['### Needs attention', ...urgent.map((u) => `- ${u}`), ''] : []),
  '### Status',
  ...lines,
].join('\n');

if (format === 'markdown') {
  process.stdout.write(`${markdown}\n`);
} else {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `${markdown}\n\nIf anything above needs attention, mention it to the user briefly at a natural point. ` +
        'The /maintenance skill (.claude/skills/maintenance/SKILL.md) handles each item.',
    },
  };
  if (urgent.length) {
    output.systemMessage = `Chevron maintenance: ${urgent.length} item(s) need attention. Run /maintenance.`;
  }
  process.stdout.write(JSON.stringify(output));
}
