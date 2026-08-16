// Bare-return form: the body never touches `exports`, so what it returns is
// what include() resolves to.
const backoff = (n) => n * 2;
return { backoff, kind: "returned" };
