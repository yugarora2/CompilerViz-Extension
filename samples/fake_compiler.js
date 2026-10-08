// A pretend compiler for testing the extension BEFORE touching MiniLang.
// Simulates:   x = 1 + 2 * 3;   (on line 1 of the source file)
// Run it:  node samples/fake_compiler.js
const e = (...a) => console.log('@VIZ:' + a.join('|'));

console.log('hello from the fake compiler (non-VIZ lines go to the Output panel)');
e('NODE', 'n1', 'Num 1', 1);
e('NODE', 'n2', 'Num 2', 1);
e('NODE', 'n3', 'Num 3', 1);
e('NODE', 'n4', "BinOp '*'", 1);
e('EDGE', 'n4', 'n2', 'left');
e('EDGE', 'n4', 'n3', 'right');
e('TAC', 0, '*', '2', '3', 't1', 1);
e('NODE', 'n5', "BinOp '+'", 1);
e('EDGE', 'n5', 'n1', 'left');
e('EDGE', 'n5', 'n4', 'right');
e('TAC', 1, '+', '1', 't1', 't2', 1);
e('NODE', 'n6', 'Var x', 1);
e('NODE', 'n7', 'Assign', 1);
e('EDGE', 'n7', 'n6', 'target');
e('EDGE', 'n7', 'n5', 'value');
e('TAC', 2, '=', 't2', '-', 'x', 1);
