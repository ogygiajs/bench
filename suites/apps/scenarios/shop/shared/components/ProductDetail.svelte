<script>
	/** A product's page body: name, price, description, specs. Static. */
	let { product } = $props();
</script>

<div class="detail">
	<span class="swatch big" style:background={product.color}>{product.name.split(' ').map((w) => w[0]).join('')}</span>
	<div class="info">
		<h1>{product.name}</h1>
		<p class="price">${product.price.toFixed(2)}</p>
		<p class="rating">Rated {product.rating.toFixed(1)} of 5</p>
		<p>{product.description}</p>
		<table class="specs">
			<tbody>
				{#each product.specs as [k, v] (k)}<tr><th>{k}</th><td>{v}</td></tr>{/each}
			</tbody>
		</table>
	</div>
</div>
