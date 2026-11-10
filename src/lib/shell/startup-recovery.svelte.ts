export function createStartupRecovery(host: {
	reload: () => void;
	copy: (text: string) => Promise<void>;
}) {
	let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
	return {
		get copyState() {
			return copyState;
		},
		retry() {
			host.reload();
		},
		async copy(text: string) {
			copyState = 'idle';
			try {
				await host.copy(text);
				copyState = 'copied';
			} catch {
				copyState = 'failed';
			}
		}
	};
}
