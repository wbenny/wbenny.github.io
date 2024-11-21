$(function() {
  $('#change-skin').on('click', function () {
    $("body").toggleClass("page-dark-mode");
    localStorage.setItem('bj-dark-mode', $("body").hasClass("page-dark-mode"));
    BeautifulJekyllJS.initNavbar();
  });

  if (
    localStorage.getItem('bj-dark-mode') === 'true' ||
    localStorage.getItem('bj-dark-mode') === null
  ) {
    $('#change-skin').trigger('click');
  }
});

$(function () {
  //$('[data-toggle="tooltip"]').tooltip();
  $(".slb").simplebox({
    darkMode: localStorage.getItem('bj-dark-mode') === 'true' || localStorage.getItem('bj-dark-mode') === null
  });
});
