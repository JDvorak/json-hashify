import test from 'tape';
import { JSONHash } from '../index.js';

// --- Basic Initialization Tests ---
test('JSONHash - Initialization', (t) => {
    t.plan(6);

    const hasher = new JSONHash();
    t.ok(hasher instanceof JSONHash, 'Should create an instance of JSONHash');
    t.equal(hasher.options.subtreeDepth, 2, 'Default subtreeDepth should be 2');
    t.equal(hasher.options.frequencyThreshold, 1, 'Default frequencyThreshold should be 1');
    t.equal(hasher.options.numHashFunctions, 128, 'Default numHashFunctions should be 128');
    t.equal(hasher.options.preserveArrayOrder, true, 'Default preserveArrayOrder should be true');
    t.equal(hasher.options.shingleSize, 5, 'Default shingleSize should be 5');
});

test('JSONHash - Custom Options Initialization', (t) => {
    t.plan(5);
    const options = {
        subtreeDepth: 3,
        frequencyThreshold: 2,
        numHashFunctions: 64,
        preserveArrayOrder: false,
        shingleSize: 3,
    };
    const hasher = new JSONHash(options);
    t.equal(hasher.options.subtreeDepth, 3, 'Custom subtreeDepth should be set');
    t.equal(hasher.options.frequencyThreshold, 2, 'Custom frequencyThreshold should be set');
    t.equal(hasher.options.numHashFunctions, 64, 'Custom numHashFunctions should be set');
    t.equal(hasher.options.preserveArrayOrder, false, 'Custom preserveArrayOrder should be set');
    t.equal(hasher.options.shingleSize, 3, 'Custom shingleSize should be set');
});

// --- Core Functionality Tests ---

test('JSONHash - Sketch Generation and Comparison (Identical JSON)', (t) => {
    t.plan(3);
    const numHashes = 64;
    const hasher = new JSONHash({ numHashFunctions: numHashes });
    const json1 = { name: "Alice", age: 30, city: "New York" };
    const json2 = { name: "Alice", age: 30, city: "New York" };

    const sketch1 = hasher.generateSketch(json1);
    const sketch2 = hasher.generateSketch(json2);

    t.equal(sketch1.length, numHashes, 'Sketch 1 should have correct length');
    t.equal(sketch2.length, numHashes, 'Sketch 2 should have correct length');
    t.equal(hasher.compareSketches(sketch1, sketch2), 1.0, 'Similarity for identical JSON should be 1.0');
});

test('JSONHash - Sketch Generation and Comparison (Slightly Different Value)', (t) => {
    t.plan(3);
    const numHashes = 64;
    const hasher = new JSONHash({ numHashFunctions: numHashes, shingleSize: 3 });
    const json1 = { name: "Alice Smith", address: { city: "New York" } };
    const json2 = { name: "Alice Smyth", address: { city: "New York" } };

    const sketch1 = hasher.generateSketch(json1);
    const sketch2 = hasher.generateSketch(json2);

    t.equal(sketch1.length, numHashes, 'Sketch 1 length');
    t.equal(sketch2.length, numHashes, 'Sketch 2 length');

    const similarity = hasher.compareSketches(sketch1, sketch2);
    t.ok(similarity > 0.5 && similarity < 1.0, `Similarity (${similarity.toFixed(3)}) should be high (>0.5) but < 1.0 for similar values`);
});

test('JSONHash - Sketch Generation and Comparison (Completely Different JSON)', (t) => {
    t.plan(3);
    const numHashes = 64;
    const hasher = new JSONHash({ numHashFunctions: numHashes });
    const json1 = { type: "user", id: 123, active: true, note: "This is user one" };
    const json2 = { product: "widget", price: 99.99, tags: ["a", "b"], description: "A different item" };

    const sketch1 = hasher.generateSketch(json1);
    const sketch2 = hasher.generateSketch(json2);

    t.equal(sketch1.length, numHashes, 'Sketch 1 length');
    t.equal(sketch2.length, numHashes, 'Sketch 2 length');

    const similarity = hasher.compareSketches(sketch1, sketch2);
    t.ok(similarity >= 0 && similarity < 0.2, `Similarity (${similarity.toFixed(3)}) should be very low`);
});


// --- Tests for AST/UNIST-like Structures ---

test('JSONHash - Similarity on Similar Remark ASTs', (t) => {
    t.plan(3); 
    const numHashes = 64;
    const shingleSize = 4;
    const hasher = new JSONHash({ numHashFunctions: numHashes, shingleSize: shingleSize, preserveArrayOrder: true });

    // Sample AST 1: Represents roughly `# Heading\n\nParagraph text.`
    const ast1 = {
        type: 'root',
        children: [
            {
                type: 'heading',
                depth: 1,
                children: [{ type: 'text', value: 'Heading' }]
            },
            {
                type: 'paragraph',
                children: [{ type: 'text', value: 'Paragraph text.' }]
            }
        ]
    };

    // Sample AST 2: Slightly modified paragraph text
    const ast2 = {
        type: 'root',
        children: [
            {
                type: 'heading',
                depth: 1,
                children: [{ type: 'text', value: 'Heading' }]
            },
            {
                type: 'paragraph',
                children: [{ type: 'text', value: 'Paragraph text slightly modified.' }]
            }
        ]
    };

    const sketch1 = hasher.generateSketch(ast1);
    const sketch2 = hasher.generateSketch(ast2);

    t.equal(sketch1.length, numHashes, 'AST Sketch 1 length');
    t.equal(sketch2.length, numHashes, 'AST Sketch 2 length');

    const similarity = hasher.compareSketches(sketch1, sketch2);
    // Expect high similarity due to shared structure and mostly shared content
    t.ok(similarity > 0.7, `Similarity (${similarity.toFixed(3)}) should be high (>0.7) for similar ASTs`);
});

test('JSONHash - Low Similarity on Dissimilar ASTs', (t) => {
    t.plan(3); 
    const numHashes = 64;
    const shingleSize = 4;
    const hasher = new JSONHash({ numHashFunctions: numHashes, shingleSize: shingleSize });

    // AST 1: Heading + Paragraph
    const ast1 = {
        type: 'root',
        children: [
            { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Title One' }] },
            { type: 'paragraph', children: [{ type: 'text', value: 'Some content here.' }] }
        ]
    };

    // AST 2: List + Code Block
    const ast2 = {
        type: 'root',
        children: [
            {
                type: 'list',
                ordered: false,
                children: [
                    { type: 'listItem', children: [{ type: 'text', value: 'Item A' }] },
                    { type: 'listItem', children: [{ type: 'text', value: 'Item B' }] }
                ]
            },
            {
                type: 'code',
                lang: 'javascript',
                value: 'console.log("hello");'
            }
        ]
    };

    const sketch1 = hasher.generateSketch(ast1);
    const sketch2 = hasher.generateSketch(ast2);

    t.equal(sketch1.length, numHashes, 'AST Sketch 1 length');
    t.equal(sketch2.length, numHashes, 'AST Sketch 2 length');

    const similarity = hasher.compareSketches(sketch1, sketch2);
    // Expect low similarity due to completely different structure and content
    t.ok(similarity >= 0 && similarity < 0.4, `Similarity (${similarity.toFixed(3)}) should be low (<0.3) for dissimilar ASTs`);
});

test('JSONHash - Similarity on JS ASTs with Different Variable Names', (t) => {
    t.plan(5);
    const numHashes = 64;
    const shingleSize = 3; // Smaller shingle size might be better for code structure
    // Preserve array order, as it matters in ASTs (e.g., function parameters)
    const hasher = new JSONHash({ numHashFunctions: numHashes, shingleSize: shingleSize, preserveArrayOrder: true });

    // Simplified AST for: function add(a, b) { return a + b; }
    const jsAst1 = {
        type: 'Program',
        body: [
            {
                type: 'FunctionDeclaration',
                id: { type: 'Identifier', name: 'add' },
                params: [
                    { type: 'Identifier', name: 'a' },
                    { type: 'Identifier', name: 'b' }
                ],
                body: {
                    type: 'BlockStatement',
                    body: [
                        {
                            type: 'ReturnStatement',
                            argument: {
                                type: 'BinaryExpression',
                                operator: '+',
                                left: { type: 'Identifier', name: 'a' },
                                right: { type: 'Identifier', name: 'b' }
                            }
                        }
                    ]
                }
            }
        ]
    };

    // Simplified AST for: function sum(x, y) { return x + y; }
    const jsAst2 = {
        type: 'Program',
        body: [
            {
                type: 'FunctionDeclaration',
                id: { type: 'Identifier', name: 'sum' },
                params: [
                    { type: 'Identifier', name: 'x' },
                    { type: 'Identifier', name: 'y' }
                ],
                body: {
                    type: 'BlockStatement',
                    body: [
                        {
                            type: 'ReturnStatement',
                            argument: {
                                type: 'BinaryExpression',
                                operator: '+',
                                left: { type: 'Identifier', name: 'x' },
                                right: { type: 'Identifier', name: 'y' }
                            }
                        }
                    ]
                }
            }
        ]
    };

    const jsAst3 = {
        type: 'Program',
        body: [
            {
                type: 'FunctionDeclaration',
                id: { type: 'Identifier', name: 'square' },
                params: [
                    { type: 'Identifier', name: 'a' }
                ],
                body: {
                    type: 'BlockStatement',
                    body: [
                        {
                            type: 'ReturnStatement',
                            argument: {
                                type: 'BinaryExpression',
                                operator: '*',
                                left: { type: 'Identifier', name: 'a' },
                                right: { type: 'Identifier', name: 'a' }
                            }
                        }
                    ]
                }
            }
        ]
    };

    const sketch1 = hasher.generateSketch(jsAst1);
    const sketch2 = hasher.generateSketch(jsAst2);
    const sketch3 = hasher.generateSketch(jsAst3);

    t.equal(sketch1.length, numHashes, 'JS AST Sketch 1 length');
    t.equal(sketch2.length, numHashes, 'JS AST Sketch 2 length');
    t.equal(sketch3.length, numHashes, 'JS AST Sketch 3 length');
    const similarity = hasher.compareSketches(sketch1, sketch2);
    // Expect high similarity: structure is identical, only identifier names differ.
    t.ok(similarity > 0.7 && similarity < 1.0, `Similarity (${similarity.toFixed(3)}) should be high (>0.7) for structurally identical JS ASTs with different var names`);

    // 1 and 2 should be more similar than 2 and 3
    const similarity12 = hasher.compareSketches(sketch1, sketch2);
    const similarity23 = hasher.compareSketches(sketch2, sketch3);
    t.ok(similarity12 > similarity23, '1 and 2 should be more similar than 2 and 3');

});
