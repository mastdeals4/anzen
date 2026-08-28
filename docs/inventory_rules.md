# Inventory Version 1.0 Rules

These rules are mandatory.

1. Do not introduce GRN.
2. Purchase Orders never change stock.
3. Purchase Invoices never change stock.
4. Batch Creation is the only normal stock IN.
5. Sales Orders reserve only.
6. Delivery Challan approval is the only normal stock OUT.
7. Sales Invoices never change stock.
8. Every physical change uses `post_inventory_movement`.
9. Every retryable change has an operation ID.
10. Negative stock is rejected.
11. Expired batches are never reserved or delivered.
12. SO reservation and DC consumption use the same FEFO batch.
13. Edits, cancellation, and reversal append opposite movements.
14. Historical movements are never updated or deleted.
15. Batches with history are archived, not deleted.
16. Reports use canonical backend views/RPCs.
17. Anonymous users cannot execute Inventory `SECURITY DEFINER` functions.
18. Historical repairs require mathematical proof and precondition gates.
19. Ambiguous records remain manual review.
20. Finance Version 1.0 regression must pass after every Inventory release.
