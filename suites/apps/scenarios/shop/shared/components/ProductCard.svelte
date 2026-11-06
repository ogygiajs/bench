<script>
	/** One product in a grid. Static. */
	let { product } = $props();
</script>

<a class="card" href={'/product/' + product.id}>
	<span class="swatch" style:background={product.color}>{product.name.split(' ').map((w) => w[0]).join('')}</span>
	<span class="name">{product.name}</span>
	<span class="price">${product.price.toFixed(2)}</span>
</a>
