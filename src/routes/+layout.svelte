<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import favicon from '#lib/assets/favicon.svg';
	import AppShell from '#lib/shell/app-shell.svelte';
	import BootScreen from '#lib/shell/boot/boot-screen.svelte';
	import { dismissSplash } from '#lib/shell/dismiss-splash.ts';
	import { onQuitRequested, exitApp } from '#lib/client/tauri-window.ts';
	import type { LayoutProps } from './$types';
	let { children, data }: LayoutProps = $props();
	onMount(dismissSplash);
	$effect(() => {
		if (data.boot.state === 'open') return;
		return onQuitRequested(() => {
			void exitApp();
		});
	});
</script>

<svelte:head
	><link rel="icon" href={favicon} />{#if data.boot.state !== 'open'}<title>Wobble</title
		>{/if}</svelte:head
>
{#if data.boot.state === 'open'}
	<AppShell {data} {children} />
{:else}
	<BootScreen status={data.boot} />
{/if}
