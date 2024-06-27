import { projectData } from '~/data';
import type { Project } from '~/types';

export const fetchProject = () => {
  const items = new Array<Project>();
  projectData.map((p) => {
    items.push(Object.assign(new Object(), p));
  });
  items.sort(function (a, b) {
    if (a.weight && b.weight) {
      return b.weight.valueOf() - a.weight.valueOf();
    }
    if (a.weight && !b.weight) {
      return -a.weight;
    }
    if (!a.weight && b.weight) {
      return b.weight;
    }
    return b.year.valueOf() - a.year.valueOf();
  });
  return items;
};
