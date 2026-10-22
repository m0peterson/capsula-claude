// Русские формы числительных: 1 вещь, 2 вещи, 5 вещей.
export const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

export const count = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;
