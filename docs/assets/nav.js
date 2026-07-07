/* =====================================================================
   Общая шапка и подвал для всех страниц сайта.
   Подключается на каждой странице:  <script src="./assets/nav.js" defer></script>
   Активный пункт меню определяется по атрибуту  <body data-page="...">
   (home | bracket | quizzes | penalty).
   ===================================================================== */

(function () {
  "use strict";

  var LINKS = [
    { id: "home",    href: "./index.html",   label: "Главная" },
    { id: "bracket", href: "./bracket.html", label: "Плей-офф" },
    { id: "quizzes", href: "./quizzes.html", label: "Квизы" },
    { id: "penalty", href: "./penalty.html", label: "Пенальти" },
    { id: "manager", href: "./manager.html", label: "Менеджер" }
  ];

  function build() {
    var active = document.body.dataset.page || "";

    var navLinks = LINKS.map(function (l) {
      var cls = l.id === active ? ' class="active" aria-current="page"' : "";
      return '<a href="' + l.href + '"' + cls + ">" + l.label + "</a>";
    }).join("");

    var header =
      '<header class="site-header">' +
        '<div class="header-inner">' +
          '<a class="logo" href="./index.html">' +
            '<span class="ball">⚽</span>' +
            '<span>World Cup <span class="yr">2026</span></span>' +
          "</a>" +
          '<button class="nav-toggle" aria-label="Открыть меню" aria-expanded="false">☰</button>' +
          '<nav class="main-nav" aria-label="Основная навигация">' + navLinks + "</nav>" +
        "</div>" +
      "</header>";

    var footer =
      '<footer class="site-footer">' +
        '<div class="footer-inner">' +
          '<div>' +
            '<span class="footer-flags">🇺🇸 🇨🇦 🇲🇽</span><br>' +
            "FIFA World Cup 2026 · фан-сайт. Неофициальный проект, сделан на чистом HTML/CSS/JS." +
          "</div>" +
          "<nav>" + navLinks + "</nav>" +
        "</div>" +
      "</footer>";

    document.body.insertAdjacentHTML("afterbegin", header);
    document.body.insertAdjacentHTML("beforeend", footer);

    var toggle = document.querySelector(".nav-toggle");
    var nav = document.querySelector(".site-header .main-nav");
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.addEventListener("click", function (e) {
      if (e.target.tagName === "A") nav.classList.remove("open");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
