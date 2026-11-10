// Warn when the nightly e2e run has stopped leaving reports on this branch.
// Warning only: it always exits 0, so it never blocks a push.
// The newest .scratch/overnight/YYYY-MM-DD.md counts from that date's local midnight.
import { readdirSync } from 'node:fs';

const maxAgeHours = 36;
const dir = '.scratch/overnight';

let days = [];
try {
	days = readdirSync(dir)
		.map((name) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name)?.[1])
		.filter(Boolean)
		.sort();
} catch {
	// No directory yet: the same as no reports.
}

const newest = days.at(-1);
if (!newest) {
	console.warn(`Warning: no nightly e2e report in ${dir}/. Check the overnight-e2e-fix task.`);
} else {
	const [year, month, day] = newest.split('-').map(Number);
	const ageHours = (Date.now() - new Date(year, month - 1, day).getTime()) / 3_600_000;
	if (ageHours > maxAgeHours) {
		console.warn(
			`Warning: the newest nightly e2e report is ${dir}/${newest}.md, ` +
				`${Math.floor(ageHours)} h old. Check the overnight-e2e-fix task.`
		);
	}
}
