import importlib.util
from pathlib import Path
from unittest.mock import patch
import unittest


WORKER_PATH = Path(__file__).parents[1] / "src" / "crawl4ai_worker.py"
SPEC = importlib.util.spec_from_file_location("crawl4ai_worker", WORKER_PATH)
WORKER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(WORKER)


class CuratedSearchRelevanceTests(unittest.TestCase):
    def test_generic_documentation_terms_do_not_match_unrelated_ui_sources(self):
        query_tokens = WORKER.meaningful_search_tokens(
            "Check official Node.js documentation for AbortSignal.timeout and fetch signal support"
        )
        gsap = {
            "title": "GSAP Official Documentation & React Integration",
            "snippet": "Official documentation for React animations.",
            "tags": ["gsap", "react", "docs", "official"],
        }
        self.assertEqual(WORKER.curated_match_score(query_tokens, gsap), 0)

    def test_topical_terms_still_match_curated_sources(self):
        query_tokens = WORKER.meaningful_search_tokens("GSAP React animated components")
        gsap = {
            "title": "GSAP Official Documentation & React Integration",
            "snippet": "Official documentation for React animations.",
            "tags": ["gsap", "react", "docs", "official"],
        }
        self.assertGreater(WORKER.curated_match_score(query_tokens, gsap), 0)


class LiveSearchParsingTests(unittest.IsolatedAsyncioTestCase):
    async def test_preserves_case_and_extracts_provider_snippet_without_query_echo(self):
        captured = {}

        class Response:
            status_code = 200
            text = '''<div class="result"><div class="result__title"><a class="result__a" href="https://nodejs.org/api/globals.html">Global objects | Node.js Documentation</a></div><a class="result__snippet">AbortSignal.timeout(delay) creates a signal that aborts after delay milliseconds.</a></div>'''

        class Client:
            def __init__(self, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def post(self, url, data):
                captured.update(data)
                return Response()

        query = "Node.js AbortSignal.timeout() Official API Documentation"
        worker = WORKER.Crawl4AiWorker()
        with patch("httpx.AsyncClient", Client):
            result = await worker.handle_discover({"query": query, "maxResults": 10})

        self.assertEqual(captured["q"], query)
        self.assertTrue(any(item["url"] == "https://nodejs.org/api/globals.html" for item in result["items"]))
        node_result = next(item for item in result["items"] if item["url"] == "https://nodejs.org/api/globals.html")
        self.assertIn("AbortSignal.timeout(delay)", node_result["snippet"])
        self.assertNotIn(query.lower(), node_result["snippet"].lower())

    async def test_allowed_domains_apply_to_live_and_curated_candidates(self):
        class Response:
            status_code = 200
            text = '''<div class="result"><div class="result__title"><a class="result__a" href="https://react.dev/learn">React Documentation</a></div><a class="result__snippet">Documentation for React.</a></div>'''

        class Client:
            def __init__(self, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def post(self, url, data): return Response()

        with patch("httpx.AsyncClient", Client):
            result = await WORKER.Crawl4AiWorker().handle_discover({
                "query": "React GSAP documentation", "maxResults": 10, "allowedDomains": ["nodejs.org"],
            })
        self.assertEqual(result["items"], [])


if __name__ == "__main__":
    unittest.main()
