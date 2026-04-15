/**
 * @nexus-script
 * @name Basic expect/send fixture
 * @description Happy-path script for integration tests — expects "A", sends "B", expects "C".
 */

await expect("A", { timeout: 2000 });
await sendLine("B");
await expect("C", { timeout: 2000 });
