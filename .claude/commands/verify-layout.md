---
description: Use Playwright MCP to verify the React dashboard layout and DOM structure at http://127.0.0.1:5173
---

Use the Playwright MCP tools to verify the frontend layout. Requires the React dev server running on http://127.0.0.1:5173.

Steps to perform:
1. Navigate to `http://127.0.0.1:5173`
2. Take a screenshot and inspect the layout
3. Check that the sidebar (`.sidebar`) and workspace (`.workspace`) render in a 2-column grid
4. Verify `<h1>RAGaaS</h1>` is present
5. Verify the tenant selector `<select>` is present
6. Verify the chat input form is present
7. Check for CSS custom font (Inter) in computed styles
8. Report any visual regressions or broken elements

Use the Playwright MCP browser tools (`playwright_navigate`, `playwright_screenshot`, `playwright_evaluate`) to accomplish this.
