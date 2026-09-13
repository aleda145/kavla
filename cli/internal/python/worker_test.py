import unittest
from worker import analyze


class DependenciesTest(unittest.TestCase):
    def test_references(self):
        cases = [
            ('result = query_1.copy()', ['query_1']),
            ('if False:\n query_1 = None\nresult = query_1', ['query_1']),
            ('for query_1 in query_1.x:\n pass', ['query_1']),
            ('query_1: object\nresult = query_1', ['query_1']),
            ('result = [x + query_1.x for x in range(3)]', ['query_1']),
            ('# query_1\nresult = "query_1"', []),
            ('def f(query_1):\n return query_1\nresult = f(1)', []),
            ('def f():\n return query_1.copy()\nresult = f()', ['query_1']),
            ('def f():\n query_1 = 1\n return query_1\nresult = f()', []),
            ('query_1 = 1\nresult = query_1', []),
            ('query_1 = query_1.copy()\nresult = query_1', ['query_1']),
            ('import math as query_1\nresult = query_1.pi', []),
            ('result = [query_1 for query_1 in range(3)]', []),
            ('result = [x for x in query_1.x]', ['query_1']),
            ('result = (lambda query_1: query_1)(1)', []),
            ('result = shapes["query_1"].copy()', ['query_1']),
            ('def f(shapes):\n return shapes["query_1"]\nresult = f({})', []),
            ('result = shapes["result"]', ['result']),
            ('result = shapes["class"]', ['class']),
        ]
        for code, expected in cases:
            with self.subTest(code=code):
                self.assertEqual(analyze(code, ['query_1', 'result', 'class']), expected)

    def test_missing_explicit_shape(self):
        with self.assertRaisesRegex(ValueError, 'Unknown shape'):
            analyze('result = shapes["missing"]', [])

    def test_dynamic_reference_rejected(self):
        with self.assertRaisesRegex(ValueError, 'literal shape name'):
            analyze('result = shapes[name]', ['query_1'])

    def test_invalid_syntax(self):
        with self.assertRaises(SyntaxError):
            analyze('result = (', [])


if __name__ == '__main__':
    unittest.main()
