import { h } from "./dom";

/**
 * "Como usar": o caminho inteiro, do desenho ao papel, em linguagem de quem usa a máquina.
 * É só texto: não lê nem muda nada.
 */
export function createHelpDialog(): { open(): void } {
  const dialog = h("dialog", { class: "sheet help", "aria-label": "Como usar o Plotter Studio" });
  const close = () => dialog.close();
  const step = (n: string, title: string, ...body: (string | HTMLElement)[]) =>
    h("section", { class: "help-step" }, h("span", { class: "step-n", "aria-hidden": "true" }, n), h("div", null, h("h4", null, title), ...body.map((b) => (typeof b === "string" ? h("p", null, b) : b))));
  const list = (...items: string[]) => h("ul", null, ...items.map((i) => h("li", null, i)));
  const key = (k: string) => h("kbd", null, k);
  const keys = (label: string, ...ks: string[]) => h("li", null, ...ks.flatMap((k, i) => (i ? [" + ", key(k)] : [key(k)])), ` ${label}`);

  dialog.append(
    h("header", { class: "settings-head" }, h("strong", null, "Como usar"), h("button", { class: "close", title: "Fechar", "aria-label": "Fechar", onclick: close }, "✕")),
    h(
      "div",
      { class: "help-body" },
      h("p", { class: "lead" }, "São três passos, sempre na mesma ordem. Os números ficam no alto do painel da direita."),
      step(
        "1",
        "Desenho",
        "Traga o que você quer plotar com o botão “Trazer desenho”: uma imagem (PNG ou JPG, que vira traço de caneta ali mesmo), um arquivo SVG, ou um texto.",
        list(
          "Imagem: escolha o tipo na tela que abre. Traço para desenho que já é de linhas, Preto e branco para nanquim e gravura, Ilustração para pintura ou desenho colorido, Foto para fotografia.",
          "A parte branca da mesa é a sua folha. O desenho já cai dentro dela.",
          "Clique no desenho para mover, girar ou mudar o tamanho. “Encaixar na folha” faz ele ocupar o máximo possível.",
          "Se for usar mais de uma caneta, escolha a caneta de cada desenho em “Caneta”.",
        ),
      ),
      step(
        "2",
        "Conferir",
        "Aqui o programa diz se o desenho pode ir para a máquina, quanto tempo leva e quanto o servo da caneta vai trabalhar.",
        list(
          "Verde: pode plotar. Amarelo: pode, mas leia o aviso. Vermelho: não vai, e a tela diz o que corrigir.",
          "O arquivo só sai (para baixar ou para enviar) se passar em todas as regras da sua máquina.",
          "Desenho com muitos tracinhos faz o servo subir e descer demais. Quando isso acontece, a máquina descansa sozinha com a caneta em cima: é de propósito.",
        ),
      ),
      step(
        "3",
        "Plotar",
        "A lista “Antes de enviar” mostra o que falta: conectar a máquina, fazer o Home, pôr a caneta. Depois é só “Enviar desenho”.",
        list(
          "Antes de qualquer traço, o servo bate 8 vezes no ar, no canto da mesa. É o aquecimento.",
          "“Pausar” levanta a caneta e espera. “Parar” encerra, mantendo a posição.",
          "Se parar no meio (faltou luz, a caneta falhou), a opção “Retomar de onde parou” aparece em “O que enviar”. Não mexa no papel.",
          "Com mais de uma caneta, cada uma é uma camada: plote na ordem da lista e troque só a caneta entre uma e outra. As cruzes na borda de baixo têm que cair uma em cima da outra.",
        ),
      ),
      h(
        "section",
        { class: "help-extra" },
        h("h4", null, "Parada de emergência"),
        h("p", null, key("Esc"), " com a máquina andando para tudo na hora (o botão vermelho “Emergência” faz o mesmo). Depois disso é preciso refazer o Home."),
        h("h4", null, "Atalhos na mesa"),
        h(
          "ul",
          { class: "help-keys" },
          keys("desfaz", "Ctrl", "Z"),
          keys("refaz", "Ctrl", "Y"),
          keys("duplica o desenho", "Ctrl", "D"),
          keys("seleciona tudo", "Ctrl", "A"),
          keys("apaga o desenho selecionado", "Delete"),
          h("li", null, key("←"), key("↑"), key("↓"), key("→"), " movem 1 mm (com ", key("Shift"), ", 10 mm)"),
          h("li", null, "Roda do mouse aproxima; arrastar com o botão do meio (ou ", key("Espaço"), " + arrastar) move a mesa"),
        ),
        h("h4", null, "Treinar sem a máquina"),
        h("p", null, "Abra o programa pelo arquivo “Abrir Plotter Studio (simulador)”. Aparece a etiqueta SIMULADOR no alto, e tudo funciona igual, com uma máquina de mentira. Nada é enviado para a máquina de verdade."),
        h("h4", null, "Ajustes da sua máquina"),
        h("p", null, "Em “Configurações” ficam o tamanho da folha, os limites do servo, as canetas e as velocidades. Os valores iniciais são os das suas regras de G-code. “Restaurar padrão” volta a eles."),
      ),
    ),
    h("footer", { class: "settings-foot" }, h("span", { class: "spacer" }), h("button", { class: "primary", onclick: close }, "Entendi")),
  );
  document.body.append(dialog);
  return { open: () => dialog.showModal() };
}
