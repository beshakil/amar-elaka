import {
  BookOpen,
  Briefcase,
  Building2,
  Car,
  CarTaxiFront,
  ChefHat,
  Droplet,
  Flame,
  GraduationCap,
  Hammer,
  KeyRound,
  Landmark,
  LayoutGrid,
  PartyPopper,
  PawPrint,
  Pill,
  Scissors,
  Shirt,
  ShoppingBag,
  ShoppingBasket,
  Siren,
  Smartphone,
  Sofa,
  Sprout,
  Stethoscope,
  Store,
  Utensils,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * `categories.icon_key` values are Lucide names (the seed taxonomy), so web
 * shows them as themselves; an unknown key gets a generic grid rather than
 * nothing. Imported one by one to keep the bundle small.
 */
const ICONS: Record<string, LucideIcon> = {
  'key-round': KeyRound,
  'car-front': Car,
  'car-taxi-front': CarTaxiFront,
  smartphone: Smartphone,
  sofa: Sofa,
  shirt: Shirt,
  'shopping-bag': ShoppingBag,
  'shopping-basket': ShoppingBasket,
  store: Store,
  briefcase: Briefcase,
  wrench: Wrench,
  hammer: Hammer,
  'brick-wall': Building2,
  scissors: Scissors,
  utensils: Utensils,
  'cooking-pot': ChefHat,
  'graduation-cap': GraduationCap,
  school: BookOpen,
  stethoscope: Stethoscope,
  pill: Pill,
  cow: PawPrint,
  sprout: Sprout,
  'party-popper': PartyPopper,
  landmark: Landmark,
  droplet: Droplet,
  flame: Flame,
  siren: Siren,
};

export function CategoryIcon({
  iconKey,
  className,
}: {
  iconKey: string | null;
  className?: string;
}) {
  const Icon = (iconKey && ICONS[iconKey]) || LayoutGrid;
  return <Icon className={className} aria-hidden />;
}
