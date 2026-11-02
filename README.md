# 🚚 Gestor de Rotas & Logística - Instituto do Animal

Este projeto nasceu de uma necessidade real: otimizar a logística diária de recolha de cães no **Instituto do Animal**. Como gestor de operações, o meu objetivo foi criar uma ferramenta que unisse eficiência de custos e facilidade de uso no terreno.

## 🎯 O Desafio
Gerir rotas manualmente consumia tempo e gerava incertezas sobre os custos de combustível. Eu precisava de uma solução que:
1. Listasse as moradas de forma organizada.
2. Calculasse custos de combustível em tempo real.
3. Gerasse rotas inteligentes no Google Maps com um clique.

## 🛠️ Stack Tecnológica (A Perspetiva do Aprendiz)
Para construir esta solução, utilizei tecnologias modernas e leves, focando na performance mobile:
* **React + Vite**: Para uma interface ultra-rápida.
* **Tailwind CSS**: Design responsivo e focado na experiência de quem está na carrinha.
* **Leaflet**: Motor de mapas de código aberto para garantir precisão sem custos de API.
* **Lucide-React**: Biblioteca de ícones para navegação intuitiva.

## 🧠 Lógica de Desenvolvimento
O "cérebro" da aplicação foi desenhado para ser resiliente:
* **Persistência de Dados**: Utilização de `LocalStorage` para evitar perda de dados ao fechar o browser.
* **Cálculo Dinâmico**: Fórmulas matemáticas que cruzam distância e preço do combustível.
* **Precisão GPS**: Configuração de Pins via Latitude/Longitude exatas para evitar erros de nomes de ruas.

## 📱 Mobile-First
A aplicação foi configurada como uma **PWA (Progressive Web App)** através de um ficheiro `manifest.json`, permitindo que seja instalada no telemóvel como um atalho oficial, sem barras de navegação do browser, funcionando como uma App nativa.

---
*Este projeto faz parte do meu percurso como **Tech Apprentice**, demonstrando a aplicação de lógica de programação (Python/React) na resolução de problemas reais de gestão.*
