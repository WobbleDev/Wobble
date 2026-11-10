<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Label } from '#lib/components/ui/label/index.ts';
	import {
		createStorage,
		getBootStatus,
		unlockStorage,
		type BootStatus
	} from '#lib/client/boot-api.ts';
	import { copyText } from '#lib/features/settings/copy-text.ts';
	import FileReceipt from '#lib/features/settings/file-receipt.svelte';
	import { applyAppLocale, appliedLocale, type AppLocale } from '#lib/i18n/locale.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { createStartupRecovery } from '#lib/shell/startup-recovery.svelte.ts';
	import { createBootForm } from './boot-form.svelte.ts';
	import { version } from '../../../../package.json';

	let { status }: { status: BootStatus } = $props();
	let shownLocale = $state(appliedLocale());
	let passwordInput = $state<HTMLInputElement | null>(null);
	const form = createBootForm(
		untrack(() => status),
		{ create: createStorage, unlock: unlockStorage, refresh: getBootStatus, opened: invalidateAll }
	);
	const recovery = createStartupRecovery({
		reload: () => window.location.reload(),
		copy: copyText
	});
	$effect(() => form.sync(status));
	const newCredential = $derived(
		form.status.state === 'locked' && (form.status.firstRun || form.status.legacyPlaintext)
	);
	const copy = $derived.by(() => {
		void shownLocale;
		return {
			recoveryArtifact: m.boot_recovery_artifact(),
			conversionDone: m.boot_conversion_done(),
			database: m.boot_database_copy(),
			recoveryCopy: m.boot_recovery_copy(),
			continue: m.boot_continue(),
			language: m.boot_language(),
			title:
				form.status.state === 'locked' && form.status.legacyPlaintext
					? m.boot_convert_title()
					: newCredential
						? m.boot_create_title()
						: m.boot_unlock_title(),
			action: form.busy
				? newCredential
					? m.boot_encrypting()
					: m.boot_opening()
				: form.status.state === 'locked' && form.status.legacyPlaintext
					? m.boot_convert_action()
					: newCredential
						? m.boot_create_action()
						: m.boot_unlock_action(),
			passphrase: m.boot_passphrase(),
			confirm: m.boot_confirm(),
			forgot: m.boot_forgot(),
			legacy: m.boot_legacy_remnants(),
			interrupted: m.boot_interrupted(),
			failure:
				form.failure === 'required'
					? m.boot_error_required()
					: form.failure === 'confirm'
						? m.boot_error_confirm()
						: form.failure === 'wrong'
							? m.boot_error_wrong()
							: form.failure === 'recovery'
								? m.boot_error_recovery()
								: m.boot_error_failed(),
			recovery: form.status.state === 'open' ? m.error_start_title() : m.boot_recovery_failed(),
			loadBody: m.error_start_body(),
			retry: m.error_start_retry(),
			details: m.error_start_details(),
			copy: m.error_start_copy(),
			copied: m.error_start_copied(),
			copyFailed: m.error_start_copy_failed(),
			diagnostic:
				m.error_start_diagnostic({ version, status: '500' }) +
				(form.status.state === 'open' ? '\ndataset_load_failed' : '\ndatabase_recovery_required')
		};
	});
	function language(locale: AppLocale) {
		applyAppLocale(locale);
		shownLocale = locale;
	}
	onMount(() => passwordInput?.focus({ preventScroll: true }));
</script>

<main class="flex min-h-dvh items-center justify-center bg-page px-5 py-10 text-ink">
	<div class="grid w-full max-w-md gap-6">
		<div role="group" aria-label={copy.language} class="flex flex-wrap justify-end gap-1">
			<Button
				type="button"
				variant="ghost"
				size="sm"
				class={`min-h-tap md:min-h-9 ${shownLocale === 'en' ? 'underline underline-offset-4' : ''}`}
				aria-pressed={shownLocale === 'en'}
				onclick={() => language('en')}>English</Button
			>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				class={`min-h-tap md:min-h-9 ${shownLocale === 'es-419' ? 'underline underline-offset-4' : ''}`}
				aria-pressed={shownLocale === 'es-419'}
				onclick={() => language('es-419')}>Español</Button
			>
		</div>
		{#if form.status.state === 'open' && form.busy}
			<p role="status" class="text-sm">{copy.action}</p>
		{:else if form.status.state === 'open' && form.status.conversion && !form.failure}
			<h1 class="text-2xl font-semibold tracking-headline">{copy.conversionDone}</h1>
			<p class="text-sm text-ink-2">{copy.legacy}</p>
			<div class="grid gap-2">
				<h2 class="text-sm font-semibold">{copy.database}</h2>
				<FileReceipt path={form.status.conversion.databasePath} />
			</div>
			<div class="grid gap-2">
				<h2 class="text-sm font-semibold">{copy.recoveryCopy}</h2>
				<FileReceipt path={form.status.conversion.recoveryPath} />
			</div>
			<Button type="button" class="min-h-tap md:min-h-9" onclick={() => void form.continueOpen()}
				>{copy.continue}</Button
			>
		{:else if form.status.state !== 'locked'}
			<h1 class="text-2xl font-semibold tracking-headline">{copy.recovery}</h1>
			{#if form.status.state === 'open'}<p role="alert" class="text-sm text-ink-2">
					{copy.loadBody}
				</p>{/if}
			<Button
				type="button"
				class="min-h-tap justify-self-start md:min-h-9"
				onclick={() => recovery.retry()}>{copy.retry}</Button
			>
			<details>
				<summary class="min-h-tap cursor-pointer py-3 text-sm text-ink-2">{copy.details}</summary>
				<pre
					data-selectable
					class="prose-value py-3 font-mono text-xs break-all whitespace-pre-wrap text-ink-2">{copy.diagnostic}</pre>
				<Button
					type="button"
					class="min-h-tap md:min-h-9"
					variant="outline"
					onclick={() => void recovery.copy(copy.diagnostic)}>{copy.copy}</Button
				>
				{#if recovery.copyState === 'copied'}<p role="status" class="mt-3 text-sm">
						{copy.copied}
					</p>{/if}
				{#if recovery.copyState === 'failed'}<p role="alert" class="mt-3 text-sm text-state-error">
						{copy.copyFailed}
					</p>{/if}
			</details>
			{#if form.status.state === 'failed' && form.status.recoveryPath}<div class="grid gap-2">
					<h2 class="text-sm font-semibold">{copy.recoveryArtifact}</h2>
					<FileReceipt path={form.status.recoveryPath} />
				</div>{/if}
			{#if form.recoveryPath}<div class="grid gap-2">
					<h2 class="text-sm font-semibold">{copy.recoveryCopy}</h2>
					<FileReceipt path={form.recoveryPath} />
				</div>{/if}
		{:else}
			<h1 class="text-2xl font-semibold tracking-headline">{copy.title}</h1>
			<form
				autocomplete="off"
				class="grid gap-5"
				onsubmit={async (event) => {
					event.preventDefault();
					await form.submit();
					if (form.failure) passwordInput?.focus();
				}}
			>
				<div class="grid gap-2">
					<Label class="field-label" for="boot-passphrase">{copy.passphrase}</Label>
					<Input
						id="boot-passphrase"
						type="password"
						bind:ref={passwordInput}
						bind:value={form.passphrase}
						autocomplete="off"
						autocapitalize="off"
						spellcheck={false}
						disabled={form.busy}
						aria-invalid={form.failure !== null}
						aria-describedby={form.failure ? 'boot-consequence boot-error' : 'boot-consequence'}
					/>
				</div>
				{#if newCredential}<div class="grid gap-2">
						<Label class="field-label" for="boot-confirm">{copy.confirm}</Label>
						<Input
							id="boot-confirm"
							type="password"
							bind:value={form.confirm}
							autocomplete="off"
							autocapitalize="off"
							spellcheck={false}
							disabled={form.busy}
							aria-invalid={form.failure === 'confirm'}
						/>
					</div>{/if}
				<p id="boot-consequence" class="text-sm text-ink-2">{copy.forgot}</p>
				{#if form.status.state === 'locked' && form.status.legacyPlaintext}<p
						class="text-sm text-ink-2"
					>
						{copy.legacy}
					</p>{/if}
				{#if form.status.state === 'locked' && form.status.markerPending}<p
						role="status"
						class="text-sm text-ink-2"
					>
						{copy.interrupted}
					</p>{/if}
				{#if form.failure}<p id="boot-error" role="alert" class="text-sm text-state-error">
						{copy.failure}
					</p>{/if}
				{#if form.recoveryPath}<div class="grid gap-2">
						<h2 class="text-sm font-semibold">{copy.recoveryCopy}</h2>
						<FileReceipt path={form.recoveryPath} />
					</div>{/if}
				<Button type="submit" disabled={form.busy} class="min-h-tap w-full md:min-h-9"
					>{copy.action}</Button
				>
			</form>
		{/if}
	</div>
</main>
