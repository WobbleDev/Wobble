/** The synthetic Worksites the mapping specs share: plain data, no browser and no network. */

/** A synthetic Worksite described by plain numbers, so unit and browser fixtures share one shape. */
export type CompositionWorksite = {
	attributes: { name: string; options: string[] }[];
	/** Each Worker's answers, keyed by Category name; the Worksite names its own ids. */
	workers: { name: string; attributes: Record<string, string> }[];
	/** Worker index pairs, each one stored Relationship. */
	relationships: [number, number][];
};

/** The 60-Worker, 136-Relationship ring the frozen baseline captured: eight clusters in a ring. */
export function ringWorksite(): CompositionWorksite {
	const sizes = [8, 8, 8, 8, 7, 7, 7, 7];
	const workers = Array.from({ length: 60 }, (_, index) => ({
		name: `Synthetic Worker ${index + 1}`,
		attributes: {
			Department: `D${Math.floor(index / 12) + 1}`,
			Role: `R${(Math.floor(index / 3) % 4) + 1}`
		}
	}));
	const clusters: number[][] = [];
	let offset = 0;
	for (const size of sizes) {
		clusters.push(Array.from({ length: size }, (_, i) => offset + i));
		offset += size;
	}
	const seen = new Set<string>();
	const relationships: [number, number][] = [];
	const add = (a: number, b: number) => {
		const key = [a, b].sort((x, y) => x - y).join(':');
		if (seen.has(key)) return;
		seen.add(key);
		relationships.push([a, b]);
	};
	for (const cluster of clusters) {
		for (let member = 0; member < cluster.length; member += 1) {
			add(cluster[member], cluster[(member + 1) % cluster.length]);
			add(cluster[member], cluster[(member + 2) % cluster.length]);
		}
	}
	for (let c = 0; c < clusters.length; c += 1) {
		const here = clusters[c];
		const next = clusters[(c + 1) % clusters.length];
		add(here[0], next[0]);
		add(here[Math.floor(here.length / 2)], next[Math.floor(next.length / 2)]);
	}
	return {
		attributes: [
			{ name: 'Department', options: ['D1', 'D2', 'D3', 'D4', 'D5'] },
			{ name: 'Role', options: ['R1', 'R2', 'R3', 'R4'] }
		],
		workers,
		relationships
	};
}

const sixGroups = ['Assembly', 'Billing', 'Cleaning', 'Dispatch', 'Engineering', 'Facilities'];

/**
 * Six groups of six with 32 cross-group pairs (A-C 8, A-B 4, C-D 4, B-E 8, D-F 8): the
 * primary non-ring Grouped case. A few names are long, duplicated or non-ASCII, since
 * names are what a composition reserves room for.
 */
export function sixGroupWorksite(): CompositionWorksite {
	const names: Record<string, string> = {
		A0: 'Maria Fernanda Gonzalez-Hernandez de la Cruz',
		A1: 'Satyendra Bose',
		B0: 'Zoë Åkesson',
		C0: 'Marie Curie',
		D0: 'Marie Curie'
	};
	const workers = sixGroups.flatMap((group, g) =>
		Array.from({ length: 6 }, (_, index) => {
			const key = `${String.fromCharCode(65 + g)}${index}`;
			return {
				name: names[key] ?? `${group} ${['Ames', 'Bell', 'Cho', 'Diaz', 'Eze', 'Fox'][index]}`,
				attributes: { Department: group }
			};
		})
	);
	const at = (group: string, index: number) => (group.charCodeAt(0) - 65) * 6 + index;
	const relationships: [number, number][] = [];
	const ties = (from: string, to: string, count: number) => {
		for (let index = 0; index < count; index += 1) {
			relationships.push([at(from, Math.floor(index / 6)), at(to, index % 6)]);
		}
	};
	ties('A', 'C', 8);
	ties('A', 'B', 4);
	ties('C', 'D', 4);
	ties('B', 'E', 8);
	ties('D', 'F', 8);
	return {
		attributes: [{ name: 'Department', options: sixGroups }],
		workers,
		relationships
	};
}

/** Nine unequal groups' holdout: groups of 2, 6 and 1 with no Relationship at all. */
export function unequalWorksite(): CompositionWorksite {
	const groups = ['Front', 'Back', ''];
	const sizes = [2, 6, 1];
	const workers = groups.flatMap((group, g) =>
		Array.from({ length: sizes[g] }, (_, i) => ({
			name: `${group || 'Floater'} ${i + 1}`,
			attributes: (group ? { Department: group } : {}) as Record<string, string>
		}))
	);
	return {
		attributes: [{ name: 'Department', options: ['Front', 'Back'] }],
		workers,
		relationships: []
	};
}

/** Two six-Worker cliques joined by one pair, plus one disconnected Worker: the non-ring Free case. */
export function cliquesWorksite(): CompositionWorksite {
	const workers = Array.from({ length: 13 }, (_, i) => ({
		name: i === 12 ? 'Zoë Åkesson' : `Free Worker ${i + 1}`,
		attributes: { Department: 'Unused' }
	}));
	const relationships: [number, number][] = [];
	for (const from of [0, 6]) {
		for (let a = from; a < from + 6; a += 1)
			for (let b = a + 1; b < from + 6; b += 1) relationships.push([a, b]);
	}
	relationships.push([0, 6]);
	return { attributes: [{ name: 'Department', options: ['Unused'] }], workers, relationships };
}

/**
 * A hub with sixteen spokes, a ring through the spokes and chords across the middle: one
 * busy dot funnels a bundle of Relationships through the free canvas, the Free case where
 * a name has to travel to find a spot clear of ties.
 */
export function hubBundleWorksite(): CompositionWorksite {
	const spokes = 16;
	// Long names are what a name has to make room for, as in the six-group fixture.
	const workers = [
		{ name: 'Hub Henri de Toulouse-Lautrec', attributes: { Department: 'Unused' } },
		...Array.from({ length: spokes }, (_, i) => ({
			name: `Spoke Henri de Toulouse-Lautrec ${i + 1}`,
			attributes: { Department: 'Unused' }
		}))
	];
	const relationships: [number, number][] = [];
	for (let index = 0; index < spokes; index += 1) relationships.push([0, index + 1]);
	for (let index = 0; index < spokes; index += 1)
		relationships.push([index + 1, ((index + 1) % spokes) + 1]);
	for (let index = 0; index < Math.floor(spokes / 2); index += 1)
		relationships.push([index + 1, index + 1 + Math.floor(spokes / 2)]);
	return {
		attributes: [{ name: 'Department', options: ['Unused'] }],
		workers,
		relationships
	};
}

/**
 * Four clusters of 7, 6, 8 and 5 Workers, each a ring with some chords, bridged by a few
 * pairs, from a fixed seed: the multi-cluster Free case that is not a ring of rings.
 */
export function modularWorksite(seedStart = 43): CompositionWorksite {
	let seed = seedStart;
	const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
	const workers: CompositionWorksite['workers'] = [];
	const groups: number[][] = [];
	for (const size of [7, 6, 8, 5]) {
		const group: number[] = [];
		for (let i = 0; i < size; i += 1) {
			group.push(workers.length);
			workers.push({
				name: `Free Worker ${workers.length + 1}`,
				attributes: { Department: 'Unused' }
			});
		}
		groups.push(group);
	}
	const relationships: [number, number][] = [];
	const add = (a: number, b: number) => {
		if (a === b) return;
		if (relationships.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) return;
		relationships.push([a, b]);
	};
	for (const group of groups) {
		for (let i = 0; i < group.length; i += 1) {
			add(group[i], group[(i + 1) % group.length]);
			if (random() < 0.5) add(group[i], group[Math.floor(random() * group.length)]);
		}
	}
	for (let i = 0; i < groups.length; i += 1) {
		add(groups[i][0], groups[(i + 1) % groups.length][1]);
		if (random() < 0.6) add(groups[i][2], groups[(i + 2) % groups.length][0]);
	}
	return { attributes: [{ name: 'Department', options: ['Unused'] }], workers, relationships };
}
