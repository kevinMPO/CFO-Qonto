import unittest
from pathlib import Path

import marketplace


class ReadmeTitleTests(unittest.TestCase):
    def row(self, **metadata):
        manifest = {"name": "example", "description": "Example description.", **metadata}
        return marketplace.readme_table([("community", Path("example"), manifest)])

    def test_title_cannot_create_readme_sections(self):
        table = self.row(displayName="Visible title\r\n\r\n## Injected heading\n\nNext\tline")

        self.assertEqual(len(table.splitlines()), 3)
        self.assertIn("| Visible title \\#\\# Injected heading Next line |", table)

    def test_title_cannot_create_markdown_links_or_formatting(self):
        table = self.row(displayName=r"[Sign in](https://example.invalid) ![image](url) *bold* _text_ `code` ~~strike~~ \*")

        self.assertIn(
            r"| \[Sign in\]\(https://example\.invalid\) \!\[image\]\(url\) \*bold\* \_text\_ \`code\` \~\~strike\~\~ \\\* |",
            table,
        )

    def test_title_cannot_create_html_or_extra_table_cells(self):
        table = self.row(displayName="<img src='https://example.invalid'> A & B | C &#10;")

        self.assertIn(r"| &lt;img src='https://example\.invalid'&gt; A &amp; B \| C &amp;\#10; |", table)

    def test_plain_and_missing_titles_remain_supported(self):
        self.assertIn("| Tax radar |", self.row(displayName="Tax radar"))
        self.assertIn("|  | Example description. |", self.row())


if __name__ == "__main__":
    unittest.main()
