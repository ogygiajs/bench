<script>
	/** Add to cart: posts to /api/cart and shows the new count. */
	let { id } = $props();
	let status = $state('');
	let busy = $state(false);

	async function add() {
		busy = true;
		const res = await fetch('/api/cart', { method: 'POST', body: id });
		const { cart } = await res.json();
		status = `Added · ${cart} in cart`;
		busy = false;
	}
</script>

<div class="buy">
	<button class="add-to-cart" onclick={add} disabled={busy}>Add to cart</button>
	<span class="buy-status" aria-live="polite">{status}</span>
</div>
