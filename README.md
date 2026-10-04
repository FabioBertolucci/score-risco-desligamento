# Score de Risco de Desligamento

Ferramenta interna de RH. O analista informa o currículo e os comentários da entrevista; o Claude devolve uma nota de risco de desligamento precoce (0 a 100), a classificação (baixo, moderado, alto), o resumo do porquê e as evidências. Todas as avaliações ficam num ranking compartilhado, do menor ao maior risco, com campo de revisão humana.

## Identidade visual
- Logo: o site não usa logo por enquanto. Para incluir uma, adicione o arquivo em `public/` e um `<img>` na faixa do topo de `public/index.html`.
- Cores: edite as 4 variáveis em `public/brand.css` com os códigos do manual de marca.

## Rodar
```
npm install
cp .env.example .env   # preencha os valores
node --env-file=.env --no-warnings=ExperimentalWarning server.js
```
Teste sem a API (nota simulada): `npm run dev`, depois abra http://localhost:3000 e entre com a senha `teste`.

Com Docker: `docker build -t score-risco . && docker run -p 3000:3000 --env-file .env -v score-dados:/data score-risco`

## Hospedagem
Qualquer servidor com Node 22.13+ ou Docker e um disco persistente para `DATA_DIR` (servidor interno da empresa, Render, Railway, Fly.io etc.). Use HTTPS. Os dados são pessoais: restrinja o acesso à rede da empresa quando possível.

## Cuidados
- O score é apoio à decisão e precisa de revisão humana.
- O prompt (`prompt.js`) proíbe o uso de idade, gênero, raça, estado civil, gravidez, religião, deficiência, endereço e outros dados sensíveis, e exige evidência literal para cada fator.
- LGPD: defina com o jurídico a base legal e o prazo de retenção; o botão Excluir remove a avaliação do banco.
- Modelo: `claude-opus-5-5` (troque com `CLAUDE_MODEL`). Pedidos recusados pelo modelo passam automaticamente para um modelo de reserva (parâmetro `fallbacks`).
