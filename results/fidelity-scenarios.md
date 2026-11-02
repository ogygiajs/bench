# Scenario fidelity

Every app of a scenario must render the same thing on its check pages (the scenario defines what is compared).

## blog

- **ogygia**: matches · `Benchmark post (23,000 words)|28|5`
- **sveltekit**: matches · `Benchmark post (23,000 words)|28|5`

**PASS**

## docs

- **ogygia**: matches · `Deploy caching (2)|300|5|3|/docs/styling/debug-caching,/docs/styling/deploy-forms-2|3862`
- **sveltekit**: matches · `Deploy caching (2)|300|5|3|/docs/styling/debug-caching,/docs/styling/deploy-forms-2|3862`

**PASS**

## dashboard

- **ogygia**: matches · `Operations|Revenue today,Orders today,Average order,Active users|5|Order,Customer,Region,Product,Status,Amount,Date ↓|1000|ORD-10066FrancesLovelaceSouthStarterp`
- **sveltekit**: matches · `Operations|Revenue today,Orders today,Average order,Active users|5|Order,Customer,Region,Product,Status,Amount,Date ↓|1000|ORD-10066FrancesLovelaceSouthStarterp`

**PASS**

## ai-chat

- **ogygia**: matches · `Assistant|120|15|27|996|1`
- **sveltekit**: matches · `Assistant|120|15|27|996|1`

**PASS**

## shop

- **ogygia**: matches · `All products|48|Hello, Ada|Cart (3)|0|0 Compact Backpack|4|Hello, Ada|Cart (3)|1|4`
- **sveltekit**: matches · `All products|48|Hello, Ada|Cart (3)|0|0 Compact Backpack|4|Hello, Ada|Cart (3)|1|4`

**PASS**

