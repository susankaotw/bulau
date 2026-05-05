# 不老 AI 助理專案重構規則

1. 每次只允許做指定範圍修改
2. 不可自行改變任何業務規則
3. 不可自行修改 handleEvent 流程
4. 不可自行修改 doRouterSearch 流程
5. 不可自行修改會員驗證邏輯
6. 不可自行修改 LINE reply / push 時機
7. 不可自行修改 Notion query / create / patch 邏輯
8. 不可自行修改 Notion 欄位名稱
9. 不可自行修正中文亂碼
10. 不可自行修改 answer.js，除非明確指定
11. 不可自行修改 prompts/knowledge-answer.md
12. 不可自行修改 prompts/knowledge-query.md
13. 每次修改後必須執行 node --check
14. 每個 Phase 完成後必須等待人工確認
15. 每次修改前都必須確認可 rollback
